// uploads/pickSingleImage.js
export function pickSingleImage(pickedFiles) {
  const files = Array.isArray(pickedFiles) ? pickedFiles : Array.from(pickedFiles || []);
  const img = files.find((f) => f && typeof f.type === "string" && f.type.startsWith("image/"));

  if (!img) return { error: "Please select an image file." };

  return {
    file: img,
    previewUrl: URL.createObjectURL(img),
    sourceName: img.name || "uploaded-image",
  };
}
