import React, { useEffect, useRef } from "react";

export default function SearchPanel({
  file,
  previewUrl,
  searchText,
  setSearchText,
  threshold,
  setThreshold,
  loading,
  runSearch,
  clearAll,
  handleFileChange,
  chatMessages,
}) {
  const messagesEndRef = useRef(null);
  const assistantScrollRef = useRef(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
  }, [chatMessages, loading]);

  return (
    <aside className="bg-white rounded-2xl shadow-lg border border-gray-200 h-fit xl:sticky xl:top-6">
      <div className="border-b border-gray-200 px-4 py-4">
        <div className="text-sm font-semibold text-gray-900">Search</div>
        <div className="text-xs text-gray-500">Chat-style panel</div>
      </div>

      <div className="p-4 space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-3">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Assistant
          </div>

          <div
            ref={assistantScrollRef}
            className="space-y-2 h-[320px] overflow-auto pr-1"
          >
            {chatMessages.map((msg, idx) => (
              <div
                key={idx}
                className={`rounded-xl px-3 py-2 text-sm ${
                  msg.role === "user"
                    ? "bg-indigo-50 text-indigo-900"
                    : "bg-gray-50 text-gray-700"
                }`}
              >
                {msg.text}
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-gray-50 p-3">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Ask Product Matcher
          </div>

          <textarea
            className="w-full min-h-[120px] resize-none rounded-xl border border-gray-300 bg-white px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            placeholder='Describe what you want, e.g. "brown lounge chair with rounded arms"'
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (!loading) runSearch();
              }
            }}
          />

          <input
            id="search-shell-file-input"
            className="hidden"
            type="file"
            accept="image/*"
            onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
          />

          <div className="mt-3 flex gap-2 items-stretch">
            <button
              type="button"
              onClick={() => document.getElementById("search-shell-file-input")?.click()}
              className="w-14 rounded-xl border border-gray-300 bg-white hover:bg-gray-50 flex items-center justify-center overflow-hidden"
              title={file ? "Replace reference image" : "Upload reference image"}
            >
              {file && previewUrl ? (
                <img
                  src={previewUrl}
                  alt="reference"
                  className="w-full h-full object-cover"
                />
              ) : (
                <span className="text-xl">🖼️</span>
              )}
            </button>

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

          {file && (
            <div className="mt-2 text-xs text-gray-500 truncate">
              Reference: {file.name}
            </div>
          )}
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
      </div>
    </aside>
  );
}