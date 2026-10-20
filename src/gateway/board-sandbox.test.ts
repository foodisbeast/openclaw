import { describe, expect, it } from "vitest";
import {
  buildSandboxHostDocument,
  decodeSandboxHostCsp,
  normalizeSandboxHostCsp,
} from "../agents/sandbox-host.js";
import { buildWidgetDocument } from "../canvas/wrap.js";
import { WIDGET_CDN_ORIGINS } from "../plugin-sdk/widget-html.js";
import {
  buildBoardWidgetContentSecurityPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(grantState: "pending" | "granted", netOrigins = ["https://api.open-meteo.com"]) {
  return { grantState, declared: { netOrigins } };
}

function sandboxCsp(widget: Parameters<typeof buildBoardWidgetSandboxPath>[0]) {
  const path = buildBoardWidgetSandboxPath(widget);
  return decodeSandboxHostCsp(new URL(path, "https://sandbox.example").searchParams.get("csp"));
}

describe("board widget sandbox CSP", () => {
  it("permits HTTPS and generated media without granting other network access", () => {
    const csp = sandboxCsp(document("pending"));
    const html = buildWidgetDocument(
      "Video",
      '<video src="https://media.example/video.mp4"></video>',
    );
    const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    for (const policy of [
      meta,
      buildSandboxHostDocument(csp).headers["Content-Security-Policy"],
      buildBoardWidgetContentSecurityPolicy(document("pending")),
    ]) {
      const directives = policy?.split(";").map((entry) => entry.trim().split(/\s+/u));
      const media = directives?.find((tokens) => tokens[0] === "media-src");
      expect(media).toEqual(expect.arrayContaining(["https:", "blob:", "data:"]));
      expect(media).not.toContain("http:");
      expect(directives?.find((tokens) => tokens[0] === "connect-src")).toEqual([
        "connect-src",
        "'none'",
      ]);
      for (const name of ["script-src", "style-src", "font-src", "img-src"]) {
        expect(directives?.find((tokens) => tokens[0] === name)).not.toContain("https:");
      }
    }
    const genericMedia = buildSandboxHostDocument()
      .headers["Content-Security-Policy"].split(";")
      .find((entry) => entry.trim().startsWith("media-src "));
    expect(genericMedia).not.toContain("https:");
  });

  it("normalizes media-only sources without widening resource or connection sources", () => {
    const csp = normalizeSandboxHostCsp({
      mediaDomains: [
        "https:",
        "blob:",
        "https://media.example",
        "javascript:",
        "https:; connect-src *",
      ],
      resourceDomains: ["https:", "blob:"],
      connectDomains: ["https:"],
    });
    expect(csp).toEqual({ mediaDomains: ["https:", "blob:", "https://media.example"] });
  });

  it("grants API access only to the declared widget origins", () => {
    const origins = [
      "https://api.open-meteo.com",
      "https://status.example:8443",
      "https://[2001:db8::1]:9443",
    ];
    const csp = sandboxCsp(document("granted", origins));

    expect(csp).toEqual({
      connectDomains: origins,
      blockDescendantFrames: true,
      resourceDomains: [...WIDGET_CDN_ORIGINS],
      mediaDomains: ["https:", "blob:"],
    });
    for (const policy of [
      buildSandboxHostDocument(csp).headers["Content-Security-Policy"],
      buildBoardWidgetContentSecurityPolicy(document("granted", csp?.connectDomains)),
    ]) {
      expect(policy).toContain(`connect-src ${origins.join(" ")}`);
    }
  });

  it("preserves registered resource origins alongside the widget CDNs without granting fetch", () => {
    const widget = {
      ...document("pending"),
      resourceOrigins: ["https://plugin-assets.example", "https://cdn.jsdelivr.net"],
    };
    const csp = sandboxCsp(widget);

    expect(csp?.resourceDomains).toEqual([...WIDGET_CDN_ORIGINS, "https://plugin-assets.example"]);
    expect(csp?.connectDomains).toBeUndefined();
    const policy = buildBoardWidgetContentSecurityPolicy(widget);
    expect(policy).toContain("https://plugin-assets.example");
    expect(policy).toContain("connect-src 'none'");
  });

  it("adds the requested descendant-frame guard before resetting document port offers", () => {
    const proxy = buildSandboxHostDocument({ blockDescendantFrames: true }).html;
    const genericProxy = buildSandboxHostDocument().html;

    for (const snippet of [
      "const blockDescendantFrames = true",
      "sandbox descendant browsing contexts are disabled",
      'lock(Document.prototype,\\"createElement\\"',
      'wrapSetter(Element.prototype,\\"innerHTML\\"',
      'wrapMethod(Element.prototype,\\"setHTMLUnsafe\\"',
      "const apply=Reflect.apply",
      'if (html.slice(index, index + 4) !== "<!--") break',
      'const commentEnd = html.indexOf("-->", index + 4)',
    ]) {
      expect(proxy).toContain(snippet);
    }
    const guardedHtmlIndex = proxy.indexOf("const guardedHtml = guardDocument(params.html)");
    expect(guardedHtmlIndex).toBeGreaterThan(-1);
    expect(proxy.indexOf("widgetPortsOffered.clear()", guardedHtmlIndex)).toBeGreaterThan(
      guardedHtmlIndex,
    );
    expect(genericProxy).toContain("const blockDescendantFrames = false");
    expect(genericProxy).not.toContain('lock(Document.prototype,\\"createElement\\"');
  });
});
