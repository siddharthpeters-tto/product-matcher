import React, { useState, useRef } from "react";
import getCroppedImg from "./CropImage";
import BoxCropper from "./BoxCropper";
import { Eraser } from "lucide-react"; // at top with other imports

const API_URL = "https://product-matcher-production-dc50.up.railway.app/search";

export default function ProductSearch() {
  const [threshold, setThreshold] = useState(0.25);
  const [results, setResults] = useState([]);
  const [groupedResults, setGroupedResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [message, setMessage] = useState("");
  const [uploadedFile, setUploadedFile] = useState(null);
  const fileInputRef = useRef(null);

  const [showCropper, setShowCropper] = useState(false);
  const [lastCropURL, setLastCropURL] = useState(null);

  const [searchMode, setSearchMode] = useState("direct"); // direct | lens

  // NEW: remember if BG removal was used, purely for UI state
  const [removeBgUsed, setRemoveBgUsed] = useState(false); // <— NEW

  const fetchResults = async ({ file, text, removeBgFlag = false }) => { // <— CHANGED
    setLoading(true);
    setResults([]);
    setMessage("");

    try {
      if (!file && (!text || text.trim() === "")) {
        setMessage("Please provide an image or text to search.");
        setLoading(false);
        return null;
      }

      const queryParams = new URLSearchParams({
        threshold: threshold.toString(),
      });
      if (text) queryParams.append("text", text.trim());
      if (removeBgFlag) queryParams.append("remove_bg", "1"); // <— NEW

      const endpoint = `${API_URL}?${queryParams.toString()}`;
      const fetchOptions = { method: "POST" };
      if (file) {
        const formData = new FormData();
        formData.append("file", file);
        fetchOptions.body = formData;
      }

      const res = await fetch(endpoint, fetchOptions);
      const data = await res.json();

      if (res.ok && data.results?.length > 0) {
        setResults(data.results);
        const grouped = data.results.reduce((acc, item) => {
          const key = item.variant_id;
          if (!acc[key]) acc[key] = { ...item, images: [] };
          acc[key].images.push({
            image_id: item.image_id,
            image_path: item.image_path,
            score: item.score,
          });
          return acc;
        }, {});
        setGroupedResults(Object.values(grouped));
        setMessage(`Found ${data.results.length} matches.`);
      } else {
        setGroupedResults([]);
        setMessage("No matching products found above the threshold.");
      }
        return data; // <-- add this
    } catch (err) {     
      setMessage("Search error: " + err.message);
      return null; // <-- add this
    } finally {
      setLoading(false);
    }
  };

const handleUpload = (eOrFile) => {
  const file = eOrFile?.target ? eOrFile.target.files?.[0] : eOrFile;
  if (lastCropURL) URL.revokeObjectURL(lastCropURL);
  if (imagePreview) URL.revokeObjectURL(imagePreview);
  if (!file) {
    // clear the input in case user cancelled
    if (eOrFile?.target) eOrFile.target.value = "";
    return;
  }

  setUploadedFile(file);
  const url = URL.createObjectURL(file);
  setImagePreview(url);
  setMessage("");

  if (searchMode === "lens") {
    setLastCropURL(null);
    setShowCropper(true);
  } else {
    setLastCropURL(url);
    setLoading(true);
    fetchResults({ file });
  }

  // IMPORTANT: allow the same file to be picked again later
  if (eOrFile?.target) eOrFile.target.value = "";
};


const handleTextSearch = () => {
  setLastCropURL(null);
  setImagePreview(null);
  fetchResults({ text: searchText });
};

const handleCropDone = async (px) => {
  try {
    if (!px || !uploadedFile) return;

    // Prefer the existing preview URL; fall back to a temp URL only if needed
    let sourceURL = imagePreview;
    let createdTemp = false;
    if (!sourceURL) {
      sourceURL = URL.createObjectURL(uploadedFile);
      createdTemp = true;
    }

    const blob = await getCroppedImg(sourceURL, px);
    if (createdTemp && sourceURL.startsWith("blob:")) URL.revokeObjectURL(sourceURL);

    const url = URL.createObjectURL(blob);
    if (lastCropURL) URL.revokeObjectURL(lastCropURL);
    setLastCropURL(url);       // <- you see exactly what is being searched
    setShowCropper(false);
    setLoading(true);
    setRemoveBgUsed(false);       // reset flag on a fresh crop  // <— NEW


    await fetchResults({
      file: new File([blob], uploadedFile.name || "crop.jpg", { type: "image/jpeg" }),
      removeBgFlag: false,        // first pass: no BG removal   // <— NEW
    });
  } catch (e) {
    setLoading(false);
    setMessage("Crop failed: " + (e?.message || e));
  }
};

const handleReset = () => {
  if (lastCropURL?.startsWith("blob:")) URL.revokeObjectURL(lastCropURL);
  if (imagePreview) URL.revokeObjectURL(imagePreview);
  setImagePreview(null);
  setLastCropURL(null);
  setResults([]);
  setGroupedResults([]);
  setMessage("");
  setShowCropper(false);
  setSearchText("");
  setUploadedFile(null);
  setRemoveBgUsed(false); // <— NEW
  if (fileInputRef.current) fileInputRef.current.value = "";
};

  // NEW: one-click “remove background & re-run” using the existing cropped preview
  const retryWithBgRemoval = async () => {                       // <— NEW
    if (!lastCropURL) return;
    setLoading(true);
    try {
      const resp = await fetch(lastCropURL);
      const blob = await resp.blob();
      const data = await fetchResults({
        file: new File([blob], "crop.jpg", { type: "image/jpeg" }),
        removeBgFlag: true,
      });
      if (data?.preview) {
        // If you were showing a blob: URL before, it’s safe to revoke it
        if (lastCropURL.startsWith("blob:")) URL.revokeObjectURL(lastCropURL);
        setLastCropURL(data.preview); // backend’s BG-removed data URL
      }      
      setRemoveBgUsed(true);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto bg-white shadow-xl rounded-2xl p-8 space-y-8">
        <div className="flex justify-center space-x-6">
        <label className="flex items-center space-x-2">
            <input type="radio" value="direct" checked={searchMode === "direct"} onChange={(e) => setSearchMode(e.target.value)} />
            <span>Product</span>
        </label>
        <label className="flex items-center space-x-2">
            <input type="radio" value="lens" checked={searchMode === "lens"} onChange={(e) => setSearchMode(e.target.value)} />
            <span>Scene</span>
        </label>

        {/* Add Clear here */}
        {(imagePreview || lastCropURL || groupedResults.length > 0) && (
            <button
            onClick={handleReset}
            className="text-sm text-red-600 hover:text-red-800"
            >
            × Clear
            </button>
        )}
        </div>
      
      {!showCropper && lastCropURL && (
        <div className="relative w-full h-80 bg-gray-50 rounded-lg border border-gray-200 overflow-hidden">
          <img
            src={lastCropURL}
            alt="Selected region"
            className="absolute inset-0 w-full h-full object-contain"
          />
          {loading && (
            <div className="absolute inset-0 bg-white/50 backdrop-blur-sm flex items-center justify-center">
              <span className="text-indigo-700 font-semibold">Searching…</span>
            </div>
          )}

          {/* NEW: Remove BG button, bottom-right inside the preview */}
          {!loading && (
            <button
              onClick={retryWithBgRemoval}
              disabled={loading}
              className={`absolute bottom-2 right-2 flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium shadow ${
                loading
                  ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                  : "bg-indigo-600 text-white hover:bg-indigo-700"
              }`}
            >
              <Eraser className="w-4 h-4" />
              {removeBgUsed ? "BG removed" : "Remove BG"}
            </button>
          )}
        </div>
      )}

      
      {/* Upload */}
      {!showCropper && !lastCropURL && (
        <div className="border-2 border-dashed border-gray-300 p-8 rounded-xl text-center cursor-pointer hover:bg-gray-50"
            onClick={() => document.getElementById("fileInput").click()}>
          <p className="text-gray-500">Drag & drop or click to upload</p>
          <input
            id="fileInput"
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleUpload}
          />
        </div>
      )}

      {/* Cropper */}
        {showCropper && imagePreview && (
          <div className="relative w-full h-96 bg-black rounded-lg overflow-hidden">
            <BoxCropper
              src={imagePreview}
              onConfirm={(px) => handleCropDone(px)}
              onCancel={() => setShowCropper(false)}
            />
          </div>
        )}


      {/* Text Search */}
      <div className="flex space-x-2">
        <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="e.g., Scandinavian wooden chair" className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <button 
          onClick={handleTextSearch} disabled={loading} className={`px-5 py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700 ${loading ? "opacity-60 cursor-not-allowed" : ""}`}>{loading ? "Searching…" : "Search"}
        </button>
      </div>

      {/* Threshold */}
      <div>
        <label className="block text-gray-700 text-sm font-bold mb-2">Similarity Threshold: {threshold.toFixed(2)}</label>
        <input type="range" min="0.1" max="0.9" step="0.05" value={threshold} onChange={(e) => setThreshold(parseFloat(e.target.value))} className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer" />
      </div>

      {/* Results */}
      {message && <p className="text-gray-600 text-sm">{message}</p>}
      {groupedResults.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 mt-8">
          {groupedResults.map((variant, i) => (
            <div key={i} className="p-4 border border-gray-200 rounded-xl shadow-md bg-white">
              <a href={variant.product_url} target="_blank" rel="noopener noreferrer" className="block text-indigo-700 font-semibold text-base underline truncate hover:text-indigo-900">{variant.variant_name}</a>
              <div className="text-sm text-gray-600 truncate">{variant.brand_name}</div>
              <div className="flex flex-wrap gap-2 mt-3">
                {variant.images.map((img, j) => (
                  <img key={j} src={img.image_path} alt={variant.variant_name} className="w-20 h-20 object-contain rounded-md shadow-sm" />
                ))}
              </div>
              <div className="mt-3 text-sm font-medium text-indigo-700">Best Match: {(Math.max(...variant.images.map((i) => i.score)) * 100).toFixed(1)}%</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
