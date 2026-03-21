import React, { useMemo, useState } from "react";
import { searchOneFile, searchTextOnly } from "./ProductSearch.jsx";

export default function SearchShell() {
  const [searchText, setSearchText] = useState("");
  const [threshold, setThreshold] = useState(0.25);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Ready to search");
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [results, setResults] = useState([]);

  const hasInput = useMemo(() => {
    return !!file || !!searchText.trim();
  }, [file, searchText]);

  async function runSearch() {
    if (!hasInput || loading) return;

    setLoading(true);
    setMessage("Searching...");
    setResults([]);

    try {
      const out = file
        ? await searchOneFile({
            file,
            text: searchText,
            threshold,
          })
        : await searchTextOnly({
            text: searchText,
            threshold,
          });

      setResults(out.groupedResults || []);
      setMessage(`Found ${out.groupedResults?.length || 0} products.`);
    } catch (e) {
      setMessage(e?.message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function handleFileChange(nextFile) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    if (!nextFile) {
      setFile(null);
      setPreviewUrl("");
      return;
    }

    setFile(nextFile);
    setPreviewUrl(URL.createObjectURL(nextFile));
  }

  function clearAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
    setSearchText("");
    setResults([]);
    setMessage("Ready to search");
  }

  return (
    <div className="min-h-screen bg-gray-100">
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
          <main className="bg-white rounded-2xl shadow-lg p-6">
            <div
              className="border-2 border-dashed border-gray-300 rounded-xl text-center cursor-pointer px-4 py-10 hover:bg-gray-50"
              onClick={() => document.getElementById("search-shell-file-input")?.click()}
            >
              {!file ? (
                <div className="text-sm text-gray-500">
                  Click to upload an image
                </div>
              ) : (
                <div className="relative w-full h-72 bg-white rounded-lg overflow-hidden">
                  <img
                    src={previewUrl}
                    alt="uploaded"
                    className="absolute inset-0 w-full h-full object-contain"
                  />
                </div>
              )}

              <input
                id="search-shell-file-input"
                className="hidden"
                type="file"
                accept="image/*"
                onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
              />
            </div>

            <section className="mt-8">
              {loading ? (
                <div className="text-center text-sm text-gray-500 py-12">
                  Searching...
                </div>
              ) : results.length === 0 ? (
                <div className="text-center text-sm text-gray-500 py-12">
                  No results yet
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
                    {results.map((item, i) => (
                      <div
                        key={`${item.variant_id}-${i}`}
                        className="p-4 border border-gray-200 rounded-xl shadow-sm bg-white"
                      >
                        <a
                          href={item.product_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="block text-indigo-700 font-semibold text-base underline truncate hover:text-indigo-900"
                        >
                          {item.variant_name}
                        </a>

                        <div className="text-sm text-gray-600 truncate">
                          {item.brand_name}
                        </div>

                        <div className="mt-2 text-sm font-medium text-indigo-700">
                          Match: {((item.images?.[0]?.score ?? item.score ?? 0) * 100).toFixed(1)}%
                        </div>

                        {item.images?.[0]?.image_path ? (
                          <img
                            src={item.images[0].image_path}
                            alt={item.variant_name}
                            className="w-full h-40 object-contain rounded-md mt-3 bg-white border"
                          />
                        ) : (
                          <div className="w-full h-40 rounded-md mt-3 bg-gray-50 border" />
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </section>
          </main>

          <aside className="bg-white rounded-2xl shadow-lg border border-gray-200 h-fit xl:sticky xl:top-6">
            <div className="border-b border-gray-200 px-4 py-4">
              <div className="text-sm font-semibold text-gray-900">Search</div>
              <div className="text-xs text-gray-500">Chat-style panel</div>
            </div>

            <div className="p-4 space-y-4">
              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Search prompt
                </div>

                <textarea
                  className="w-full min-h-[120px] resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  placeholder='e.g. "brown lounge chair with rounded arms"'
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      if (!loading) runSearch();
                    }
                  }}
                />

                <div className="mt-3 flex gap-2">
                  <button
                    onClick={runSearch}
                    disabled={loading}
                    className={`flex-1 px-4 py-3 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 ${
                      loading ? "opacity-60 cursor-not-allowed" : ""
                    }`}
                  >
                    {loading ? "Searching..." : "Search"}
                  </button>

                  <button
                    type="button"
                    onClick={clearAll}
                    className="px-4 py-3 rounded-xl border font-semibold border-gray-300 text-gray-800 hover:bg-gray-50"
                  >
                    Clear
                  </button>
                </div>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Similarity Threshold
                </div>
                <div className="text-sm font-semibold text-gray-800 mb-2">
                  {threshold.toFixed(2)}
                </div>
                <input
                  type="range"
                  min="0.1"
                  max="0.9"
                  step="0.01"
                  value={threshold}
                  onChange={(e) => setThreshold(Number(e.target.value))}
                  className="w-full"
                />
              </div>

              <div className="rounded-2xl border border-gray-200 bg-white p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
                  Status
                </div>
                <div className="text-sm text-gray-700 min-h-[40px]">
                  {message}
                </div>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}