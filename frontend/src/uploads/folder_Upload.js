// folderUpload.js
export function pickFolderImages(pickedFiles, { makeItem } = {}) {
  const imgs = Array.from(pickedFiles || []).filter((f) => f?.type?.startsWith("image/"));
  const items = makeItem ? imgs.map((f) => makeItem(f, f.name, "image")) : imgs;

  return {
    items,
    message: items.length ? `Loaded ${items.length} images.` : "No images found.",
  };
}
