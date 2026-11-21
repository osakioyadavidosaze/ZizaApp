export async function compressImage(
  file: File,
  maxDimension = 1600,
  quality = 0.78,
): Promise<File> {
  let source: CanvasImageSource;
  let width: number;
  let height: number;
  let cleanup = () => {};

  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      source = bitmap;
      width = bitmap.width;
      height = bitmap.height;
      cleanup = () => bitmap.close();
    } catch {
      const objectUrl = URL.createObjectURL(file);
      const image = new Image();
      image.src = objectUrl;
      try {
        await image.decode();
      } catch (caught) {
        URL.revokeObjectURL(objectUrl);
        throw new Error(caught instanceof Error ? caught.message : "Could not read the selected image.");
      }
      source = image;
      width = image.naturalWidth;
      height = image.naturalHeight;
      cleanup = () => URL.revokeObjectURL(objectUrl);
    }
  } else {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.src = objectUrl;
    try {
      await image.decode();
    } catch (caught) {
      URL.revokeObjectURL(objectUrl);
      throw new Error(caught instanceof Error ? caught.message : "Could not read the selected image.");
    }
    source = image;
    width = image.naturalWidth;
    height = image.naturalHeight;
    cleanup = () => URL.revokeObjectURL(objectUrl);
  }

  try {
    const scale = Math.min(1, maxDimension / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image compression is not supported in this browser.");
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error("Could not compress the selected image."));
      }, "image/jpeg", quality);
    });
    const name = file.name.replace(/\.[^.]+$/, "") || "story";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: Date.now() });
  } finally {
    cleanup();
  }
}
