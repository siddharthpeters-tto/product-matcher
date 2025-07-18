import React, { useState, useEffect } from "react";

// IMPORTANT: Replace this with your deployed Modal FastAPI app URL
// Example: const API_URL = "https://your-modal-app-name-your-username.modal.run/search";
const API_URL = "https://product-matcher-production-dc50.up.railway.app/search"; // Placeholder, update after deployment
//const API_URL = "http://localhost:8000/search";


export default function ProductSearch() {
  const [threshold, setThreshold] = useState(0.25); // Adjusted default threshold
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const [imagePreview, setImagePreview] = useState(null);
  const [uploadedFile, setUploadedFile] = useState(null);
  const [searchText, setSearchText] = useState("");
  const [indexType, setIndexType] = useState("color");
  const [message, setMessage] = useState(""); // For user messages/errors

  // Effect to trigger search when indexType changes if there's already input
  useEffect(() => {
    if (uploadedFile) {
      fetchResults({ file: uploadedFile });
    } else if (searchText.trim()) {
      fetchResults({ text: searchText.trim() });
    } else {
      // Do not call fetchResults at all
      setMessage("Please upload an image or enter text before switching search mode.");
    }
  }, [indexType]);


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

    const formData = new FormData();
    if (file) formData.append("file", file);

    const queryParams = new URLSearchParams({
      index_type: indexType,
      threshold: threshold.toString(),
    });
    if (text) queryParams.append("text", text.trim());

    const endpoint = `${API_URL}?${queryParams.toString()}`;

    const res = await fetch(endpoint, {
      method: "POST",
      body: formData,
    });

    const data = await res.json();
    if (res.ok) {
      if (data.results?.length > 0) {
        setResults(data.results);
        setMessage(`Found ${data.results.length} matches.`);
      } else {
        setResults([]);
        setMessage("No matching products found above the threshold.");
      }
    } else {
      throw new Error(data.error || "Unknown error from API.");
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
      <section>
        <label className="block text-gray-700 text-sm font-bold mb-2">Search Mode:</label>
        <div className="flex items-center space-x-4">
          <label className="inline-flex items-center">
            <input type="radio" value="color" checked={indexType === "color"} onChange={e => setIndexType(e.target.value)} className="form-radio text-indigo-600" />
            <span className="ml-2 text-gray-700">Color</span>
          </label>
          <label className="inline-flex items-center">
            <input type="radio" value="structure" checked={indexType === "structure"} onChange={e => setIndexType(e.target.value)} className="form-radio text-indigo-600" />
            <span className="ml-2 text-gray-700">Structure (Grayscale)</span>
          </label>
          <label className="inline-flex items-center">
            <input type="radio" value="combined" checked={indexType === "combined"} onChange={e => setIndexType(e.target.value)} className="form-radio text-indigo-600" />
            <span className="ml-2 text-gray-700">Combined</span>
          </label>
        </div>
      </section>

      <section>
        <label className="block text-gray-700 text-sm font-bold mb-2">Upload Image:</label>
        <input type="file" accept="image/*" onChange={handleUpload} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-indigo-50 file:text-indigo-700 hover:file:bg-indigo-100" />
      </section>

      <section>
        <label className="block text-gray-700 text-sm font-bold mb-2">Or Search by Text:</label>
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
            className="flex-1 px-4 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
          />
          <button onClick={handleTextSearch} className="px-5 py-2 bg-indigo-600 text-white font-semibold rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2">
            Search
          </button>
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
          <img src={imagePreview} alt="preview" className="w-48 h-48 object-cover rounded-lg shadow-md" />
        </div>
      )}

      {loading && <p className="text-indigo-600 font-medium">🔄 Searching...</p>}
      {message && <p className="text-gray-600 text-sm">{message}</p>}

      {results.length > 0 && (
        <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-6 mt-8">
          {results.map((item, i) => (
            <div key={i} className="p-4 border border-gray-200 rounded-xl shadow-md bg-white flex flex-col items-center text-center">
              <img
                src={item.image_path}
                alt={item.product_name}
                className="w-full h-32 object-cover rounded-md mb-3"
                onError={(e) => { e.target.onerror = null; e.target.src = `https://placehold.co/128x128/e0e0e0/000000?text=No+Image`; }}
              />
              <div className="flex-grow">
                <strong className="block text-gray-900 text-base font-semibold truncate">{item.variant_name}</strong>
                <div className="text-sm text-gray-600 truncate">{item.brand_name}</div>
              </div>
              <div className="mt-3 text-sm font-medium text-indigo-700">
                Match: {(item.score * 100).toFixed(1)}%
              </div>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}