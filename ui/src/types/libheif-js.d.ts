declare module "libheif-js" {
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    is_primary(): boolean;
    display(target: ImageData, callback: (result: ImageData | null) => void): void;
    free(): void;
  }

  class HeifDecoder {
    decoder: number;
    decode(data: Uint8Array): HeifImage[];
  }

  const libheif: {
    HeifDecoder: typeof HeifDecoder;
    heif_context_free(context: number): void;
  };
  export default libheif;
}
