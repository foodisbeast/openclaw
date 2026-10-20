import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { attachmentImage } from "./chat-attachment-menu.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Mobile attachment errors" });

suite.define(() => {
  it("previews HEIC photos before sending them as JPEG", () =>
    suite.withPage({ viewport: { width: 1050, height: 764 } }, async ({ page }) => {
      const gateway = await installMockGateway(page);
      await page.goto(suite.server.baseUrl + "chat");
      const buffer = Buffer.from(
        await readFile("test/fixtures/media/green.heic.base64", "utf8"),
        "base64",
      );
      await page.locator(".agent-chat__file-input").setInputFiles([
        { name: "holiday-photo.heic", mimeType: "image/heic", buffer },
        { name: "second-photo.HEIF", mimeType: "application/octet-stream", buffer },
      ]);
      const rail = page.locator(".chat-attachments-preview");
      await expect.poll(() => rail.locator('[aria-busy="false"]').count()).toBe(2);
      expect(await rail.locator("img").count()).toBe(2);
      expect(
        await rail.locator("img").evaluateAll(async (images: HTMLImageElement[]) => {
          return await Promise.all(
            images.map(async (image) => {
              await image.decode();
              return [image.naturalWidth, image.naturalHeight];
            }),
          );
        }),
      ).toEqual([
        [64, 64],
        [64, 64],
      ]);
      await page.screenshot({
        path: path.join(suite.artifactDir, "heic-pending.png"),
        animations: "disabled",
      });
      await rail.getByRole("button", { name: "Open image holiday-photo.jpg", exact: true }).click();
      const lightbox = page.locator("openclaw-image-lightbox");
      await lightbox.getByRole("dialog").waitFor({ state: "visible" });
      await lightbox.locator("img.image").evaluate((image: HTMLImageElement) => image.decode());
      await lightbox.getByRole("button", { name: "Close image preview", exact: true }).click();
      const composer = page.getByRole("textbox", { name: "Chat composer", exact: true });
      await composer.evaluate((element, base64) => {
        const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
        const clipboard = new DataTransfer();
        clipboard.items.add(new File([bytes], "pasted-photo.heif"));
        element.dispatchEvent(
          new ClipboardEvent("paste", {
            bubbles: true,
            cancelable: true,
            clipboardData: clipboard,
          }),
        );
      }, buffer.toString("base64"));
      await expect.poll(() => rail.locator('[aria-busy="false"]').count()).toBe(3);
      await rail
        .locator("img")
        .last()
        .evaluate((image: HTMLImageElement) => image.decode());
      await composer.fill("Inspect this photo.");
      await page.getByRole("button", { name: "Send message", exact: true }).click();
      await expect
        .poll(() => gateway.getRequests("chat.send"))
        .toMatchObject([
          {
            params: {
              attachments: [
                {
                  fileName: "holiday-photo.jpg",
                  mimeType: "image/jpeg",
                  content: expect.any(String),
                },
                {
                  fileName: "second-photo.jpg",
                  mimeType: "image/jpeg",
                  content: expect.any(String),
                },
                {
                  fileName: "pasted-photo.jpg",
                  mimeType: "image/jpeg",
                  content: expect.any(String),
                },
              ],
            },
          },
        ]);
    }));
  it.each(["chat", "new"])("keeps rejected files readable and removable in %s", (route) =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        await page.clock.install();
        const gateway = await installMockGateway(page, {
          attachmentMaxBytes: 1024,
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
        });
        await page.goto(suite.server.baseUrl + route);
        const input = page.locator(".agent-chat__file-input").first();
        await input.setInputFiles({
          name: "holiday-photo.jpg",
          mimeType: "image/jpeg",
          buffer: Buffer.alloc(2048),
        });
        await page
          .locator(".app-toast__message")
          .getByText("Too large to send: holiday-photo.jpg", { exact: true })
          .waitFor();
        await page.clock.fastForward(7_000);
        const failure = page.locator(".chat-attachment-failures");
        expect(await failure.textContent()).toContain("Too large to send: holiday-photo.jpg");
        expect(await failure.textContent()).toContain("Choose a smaller file");
        expect(await page.locator(".chat-attachments-preview img").count()).toBe(0);
        expect(await gateway.getRequests("chat.send")).toEqual([]);
        await page.getByRole("button", { name: "Remove holiday-photo.jpg", exact: true }).click();
        expect(await failure.count()).toBe(0);
      },
    ),
  );
  it("downloads the original only on request when a preview is unavailable", () =>
    suite.withPage(
      { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
      async ({ page }) => {
        const id = crypto.randomUUID();
        const source = `/api/chat/media/outgoing/agent%3Amain%3Amain/${id}/full`;
        const artifactId = `artifact_managed_image_${id}`;
        const image = {
          type: "image",
          artifactId,
          url: source,
          alt: "Holiday photo",
          mimeType: "image/png",
          width: 1600,
          height: 1000,
        };
        const bytes = attachmentImage("original.png").buffer;
        const requests: string[] = [];
        await page.route("**/api/chat/media/outgoing/**", async (route) => {
          const variant = new URL(route.request().url()).pathname.split("/").at(-1)!;
          requests.push(variant);
          await route.fulfill(
            variant === "thumbnail"
              ? { status: 404, body: "Not Found" }
              : { body: bytes, contentType: "image/png" },
          );
        });
        await installMockGateway(page, {
          agentModel: "demo/model",
          models: [{ id: "model", name: "Demo", provider: "demo" }],
          historyMessages: [{ role: "assistant", content: [image], timestamp: 1 }],
          methodResponses: {
            "artifacts.download": {
              artifact: {
                id: artifactId,
                type: "image",
                title: "Holiday photo",
                mimeType: "image/png",
                download: { mode: "url" },
              },
              url: `${source}?mediaTicket=demo-ticket`,
            },
          },
        });
        await page.goto(suite.server.baseUrl + "chat");
        const card = page.locator(".chat-image-frame--compact");
        await card.waitFor({ state: "visible" });
        expect(requests).toEqual(["thumbnail"]);
        await card.getByRole("button", { name: "Image actions" }).click();
        const download = page.waitForEvent("download");
        await card.getByRole("menuitem", { name: "Download image" }).click();
        expect((await download).suggestedFilename()).toBe("Holiday photo.png");
        expect(requests).toEqual(["thumbnail", "full"]);
      },
    ));
});
