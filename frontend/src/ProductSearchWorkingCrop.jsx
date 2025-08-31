import React, { useState, useCallback } from "react";
import Cropper from "react-easy-crop";
import getCroppedImg from "./CropImage";

const API_URL = "https://product-matcher-production-dc50.up.railway.app/search";

export default function ProductSearch() {
  const [threshold, setThreshold] = useState(0.25);
  const [results, setResults] = useState([]);
  const [groupedResults, setGroupedResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [message, setMessage] = useState("");

  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedAreaPixels, setCroppedAreaPixels] = useState(null);
  const [showCropper, setShowCropper] = useState(false);
  const [lastCropURL, setLastCropURL] = useState(null);

  const [searchMode, setSearchMode] = useState("direct"); // direct | lens

  const onCropComplete = useCallback((_, areaPixels) => {
    setCroppedAreaPixels(areaPixels);
  }, []);

  const fetchResults = async ({ file, text }) => {
    setLoading(true);
    setResults([]);
    setMessage("");

    try {
      if (!file && (!text || text.trim() === "")) {
        setMessage("Please provide an image or text to search.");
        setLoading(false);
        return;
      }

      const queryParams = new URLSearchParams({
        threshold: threshold.toString(),
      });
      if (text) queryParams.append("text", text.trim());

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
    } catch (err) {
      setMessage("Search error: " + err.message);
    } finally {
      setLoading(false);
    }
  };

const handleUpload = (file) => {
  if (file) {
    const url = URL.createObjectURL(file);   // 👈 add this
    setImagePreview(url);
    setLastCropURL(null);

    if (searchMode === "lens") {
      setShowCropper(true);
    } else {
      setLastCropURL(url);                   // 👈 add this
      fetchResults({ file });
    }
  }
};


  const handleCropDone = async () => {
    try {
      if (!croppedAreaPixels) return;
      const blob = await getCroppedImg(imagePreview, croppedAreaPixels);
      const url = URL.createObjectURL(blob);
      setLastCropURL(url);
      setShowCropper(false);
      await fetchResults({ file: new File([blob], "crop.jpg", { type: "image/jpeg" }) });
    } catch (e) {
      setMessage("Crop failed: " + (e?.message || e));
    }
  };

  const handleReset = () => {
    setImagePreview(null);
    setLastCropURL(null);
    setResults([]);
    setGroupedResults([]);
    setMessage("");
    setShowCropper(false);
    setSearchText("");        // 👈 add this
    };


  return (
    <div className="max-w-5xl mx-auto bg-white shadow-xl rounded-2xl p-8 space-y-8">
        <div className="flex justify-center space-x-6">
        <label className="flex items-center space-x-2">
            <input type="radio" value="direct" checked={searchMode === "direct"} onChange={(e) => setSearchMode(e.target.value)} />
            <span>Match Product</span>
        </label>
        <label className="flex items-center space-x-2">
            <input type="radio" value="lens" checked={searchMode === "lens"} onChange={(e) => setSearchMode(e.target.value)} />
            <span>Match Product in a Scene</span>
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


      {/* Upload */}
      {!showCropper && !lastCropURL && (
        <div className="border-2 border-dashed border-gray-300 p-8 rounded-xl text-center cursor-pointer hover:bg-gray-50" onClick={() => document.getElementById("fileInput").click()}>
          <p className="text-gray-500">Drag & drop or click to upload</p>
          <input id="fileInput" type="file" accept="image/*" className="hidden" onChange={(e) => handleUpload(e.target.files[0])} />
        </div>
      )}

      {/* Cropped preview */}
      {!showCropper && lastCropURL && (
        <div className="flex flex-col items-center">
          <img src={lastCropURL} alt="Cropped Preview" className="max-h-80 rounded-lg border" />
          {loading && <p className="text-indigo-600 font-medium mt-2">🔄 Searching...</p>}
        </div>
      )}

      {/* Cropper */}
      {showCropper && imagePreview && (
        <div className="relative w-full h-96 bg-black rounded-lg overflow-hidden">
          <Cropper image={imagePreview} crop={crop} zoom={zoom} onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={onCropComplete} />
          <div className="absolute bottom-4 left-4 right-4 flex items-center space-x-4">
            <div className="flex-1 flex items-center space-x-3 bg-white/80 backdrop-blur rounded-lg px-3 py-2 shadow">
              <span className="text-xs text-gray-700 whitespace-nowrap">Zoom</span>
              <input type="range" min={1} max={4} step={0.05} value={zoom} onChange={(e) => setZoom(parseFloat(e.target.value))} className="w-full" />
            </div>
            <button onClick={handleCropDone} className="bg-indigo-600 text-white px-6 py-2 rounded-lg shadow hover:bg-indigo-700">✅ Use This Crop</button>
            <button onClick={() => setShowCropper(false)} className="bg-gray-500 text-white px-6 py-2 rounded-lg shadow hover:bg-gray-600">Cancel</button>
          </div>
        </div>
      )}

      {/* Text Search */}
      <div className="flex space-x-2">
        <input type="text" value={searchText} onChange={(e) => setSearchText(e.target.value)} placeholder="e.g., Scandinavian wooden chair" className="flex-1 px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500" />
        <button onClick={() => fetchResults({ text: searchText })} className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-lg hover:bg-indigo-700">Search</button>
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
