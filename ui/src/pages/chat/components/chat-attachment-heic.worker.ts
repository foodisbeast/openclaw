import libheif from "libheif-js";
import type { ChatAttachmentImageRequest } from "./chat-attachment-image.ts";

async function convert(file: File, maxBytes: number): Promise<File> {
  const limit = Math.min(maxBytes, 5 * 1024 * 1024);
  if (file.size > limit) {
    throw new Error("HEIC exceeds the attachment limit");
  }
  const decoder = new libheif.HeifDecoder();
  // decode() reads image handles; display() decodes pixels after the size check.
  const images = decoder.decode(new Uint8Array(await file.arrayBuffer()));
  const canvas = new OffscreenCanvas(1, 1);
  let bitmap: ImageBitmap | undefined;
  try {
    const image = images.find((candidate) => candidate.is_primary()) ?? images[0];
    if (!image) {
      throw new Error("HEIC image is missing");
    }
    const width = image.get_width();
    const height = image.get_height();
    if (width < 1 || height < 1 || width * height > 25_000_000) {
      throw new Error("HEIC dimensions exceed the decode budget");
    }
    const pixels = await new Promise<ImageData>((resolve, reject) => {
      image.display(new ImageData(width, height), (result) =>
        result ? resolve(result) : reject(new Error("HEIC decoding failed")),
      );
    });
    // libheif applies the primary image's rotation, crop, and mirror transforms.
    bitmap = await createImageBitmap(pixels);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Image cannot be converted");
    }
    let scale = Math.min(1, 4096 / Math.max(bitmap.width, bitmap.height));
    while (true) {
      canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
      canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const jpeg = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.9 });
      if (jpeg.size > 0 && jpeg.type === "image/jpeg" && jpeg.size <= limit) {
        const name = file.name.replace(/\.[^.]*$/, "") || "image";
        return new File([jpeg], `${name}.jpg`, {
          type: jpeg.type,
          lastModified: file.lastModified,
        });
      }
      if (canvas.width === 1 && canvas.height === 1) {
        throw new Error("Converted image exceeds the attachment limit");
      }
      scale *= Math.min(0.8, Math.sqrt(limit / jpeg.size) * 0.95);
    }
  } finally {
    bitmap?.close();
    canvas.width = canvas.height = 0;
    for (const image of images) {
      image.free();
    }
    libheif.heif_context_free(decoder.decoder);
  }
}

function onMessage({ data }: MessageEvent<ChatAttachmentImageRequest>) {
  globalThis.removeEventListener("message", onMessage);
  void convert(data.file, data.maxBytes).then(
    (file) => globalThis.postMessage(file, { transfer: [] }),
    () => globalThis.postMessage(null, { transfer: [] }),
  );
}

globalThis.addEventListener("message", onMessage);
