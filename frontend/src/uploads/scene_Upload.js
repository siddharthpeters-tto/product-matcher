// sceneUpload.js
export function pickSceneBase(pickedFiles) {
  const img = Array.from(pickedFiles || []).find((f) => f?.type?.startsWith("image/"));
  if (!img) return { error: "Please select an image file." };

  return {
    base: {
      file: img,
      sourceName: img.name,
      previewUrl: URL.createObjectURL(img),
    },
    message: "Draw a box around the product, then confirm.",
  };
}
