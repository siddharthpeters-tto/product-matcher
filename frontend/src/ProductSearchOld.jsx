import React, { useState, useEffect } from "react";

// IMPORTANT: Replace this with your deployed Modal FastAPI app URL
// Example: const API_URL = "https://your-modal-app-name-your-username.modal.run/search";
const API_URL = "https://product-matcher-production-dc50.up.railway.app/search"; // Placeholder, update after deployment
//const API_URL = "http://localhost:8000/search";


export default function ProductSearch() {
  const [threshold, setThreshold] = useState(0.25); // Adjusted default threshold
  const [results, setResults] = useState([]);
  const [groupedResults, setGroupedResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [indexType] = useState("color");
  const [message, setMessage] = useState(""); // For user messages/errors


const fetchResults = async ({ file, text }) => {
  setLoading(true);
  setResults([]);
  setMessage("");
  setImagePreview(file ? URL.createObjectURL(file) : null);

  try {
    if (!file && (!text || text.trim() === "")) {
      setMessage("Please provide an image or text to search.");
      setLoading(false);
      return;
    }

    const queryParams = new URLSearchParams({
      index_type: indexType,
      threshold: threshold.toString(),
    });
    if (text) queryParams.append("text", text.trim());

    const endpoint = `${API_URL}?${queryParams.toString()}`;

    let fetchOptions = { method: "POST" };

    if (file) {
      const formData = new FormData();
      formData.append("file", file);
      fetchOptions.body = formData;
    }
    // text-only: no body at all

    const res = await fetch(endpoint, fetchOptions);
    const data = await res.json();

    if (res.ok) {
      if (data.results?.length > 0) {
        setResults(data.results);

        const grouped = data.results.reduce((acc, item) => {
          const key = item.variant_id;
          if (!acc[key]) {
            acc[key] = { ...item, images: [] };
          }
          acc[key].images.push({
            image_id: item.image_id,
            image_path: item.image_path,
            score: item.score
          });
          return acc;
        }, {});
        setGroupedResults(Object.values(grouped));
        setMessage(`Found ${data.results.length} matches.`);
      } else {
        setResults([]);
        setGroupedResults([]);
        setMessage("No matching products found above the threshold.");
      }
    }
  } catch (err) {
    setMessage("Search error: " + err.message);
    console.error("Search error:", err);
  } finally {
    setLoading(false);
  }
};




  const handleUpload = (e) => {
    const file = e.target.files[0];
    if (file) {
      setUploadedFile(file);
      setSearchText(""); // Clear text search when image is uploaded
      fetchResults({ file });
    }
  };

  const handleTextSearch = () => {
    if (searchText.trim()) {
      setUploadedFile(null); // Clear uploaded file when text search is performed
      setImagePreview(null);
      fetchResults({ text: searchText.trim() });
    } else {
      setMessage("Please enter some text to search.");
    }
  };

  return (
    <div className="space-y-6">
      <section className="flex flex-col sm:flex-row sm:items-end sm:space-x-4">
        {/* Upload Image */}
        <div className="flex-1">
          <label className="block text-gray-700 text-sm font-bold mb-2">
            Upload Image:
          </label>
          <input
            type="file"
            accept="image/*"
            onChange={handleUpload}
            className="block w-full text-sm text-gray-500 
              file:mr-4 file:py-2 file:px-4 file:rounded-md 
              file:border-0 file:text-sm file:font-semibold 
              file:bg-indigo-50 file:text-indigo-700 
              hover:file:bg-indigo-100"
          />
        </div>

        {/* Or Search by Text */}
        <div className="flex-1">
          <label className="block text-gray-700 text-sm font-bold mb-2">
            Or Search by Text:
          </label>
          <div className="flex space-x-2">
            <input
              type="text"
              value={searchText}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleTextSearch();
                }
              }}
              placeholder="e.g., Scandinavian wooden chair"
              className="flex-1 px-4 py-2 border border-gray-300 rounded-md 
                focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
            <button
              onClick={handleTextSearch}
              className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-md 
                hover:bg-indigo-700 focus:outline-none 
                focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2"
            >
              Search
            </button>
          </div>
        </div>
      </section>

      <section>
        <label className="block text-gray-700 text-sm font-bold mb-2">Similarity Threshold: <span className="font-normal">{threshold.toFixed(2)}</span></label>
        <input
          type="range"
          min="0.1"
          max="0.9"
          step="0.05"
          value={threshold}
          onChange={(e) => setThreshold(parseFloat(e.target.value))}
          className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer range-thumb-indigo"
        />
      </section>

      {imagePreview && (
        <div className="mb-4">
          <p className="text-gray-700 text-sm font-bold mb-2">Preview:</p>
          <img src={imagePreview} alt="preview" className="w-48 h-48 object-contain rounded-lg shadow-md" />
        </div>
      )}

      {loading && <p className="text-indigo-600 font-medium">🔄 Searching...</p>}
      {message && <p className="text-gray-600 text-sm">{message}</p>}

      {groupedResults.length > 0 && (
        <section className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-6 mt-8">
          {groupedResults.map((variant, i) => (
            <div key={i} className="p-4 border border-gray-200 rounded-xl shadow-md bg-white">
              <a
                href={variant.product_url}
                target="_blank"
                rel="noopener noreferrer"
                className="block text-indigo-700 font-semibold text-base underline truncate hover:text-indigo-900"
              >
                {variant.variant_name}
              </a>
              <div className="text-sm text-gray-600 truncate">{variant.brand_name}</div>
              {variant.product_category && (
                <div className="inline-block mt-1 px-2 py-0.5 text-xs bg-indigo-100 text-indigo-800 rounded-full">
                {variant.product_category.toUpperCase()}
                </div>
              )}
              <div className="flex flex-wrap gap-2 mt-3">
                {variant.images.map((img, j) => (
                  <img
                    key={j}
                    src={img.image_path}
                    alt={variant.variant_name}
                    className="w-20 h-20 object-contain rounded-md shadow-sm"
                    onError={(e) => {
                      e.target.onerror = null;
                      e.target.src = `https://placehold.co/80x80/e0e0e0/000000?text=No+Image`;
                    }}
                  />
                ))}
              </div>

              <div className="mt-3 text-sm font-medium text-indigo-700">
                Best Match: {(Math.max(...variant.images.map(i => i.score)) * 100).toFixed(1)}%
              </div>
            </div>
          ))}
        </section>
      )}

    </div>
  );
}