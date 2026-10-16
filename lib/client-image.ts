// Re-encodes the poster as JPEG (max 2000 px) in the browser: small uploads,
// and one format that both Textract and Claude accept.
const MAX_SIDE = 2000;
export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function preparePoster(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Não foi possível preparar a imagem."))), "image/jpeg", 0.88),
  );
}
