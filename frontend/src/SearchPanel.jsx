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
  sendChatMessage,
  chatMessages,
  chatLoading,
  pendingAction,
  applyPendingAction,
}) {

  const assistantScrollRef = useRef(null);

  useEffect(() => {
    const el = assistantScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [chatMessages, chatLoading]);

  return (
    <aside className="bg-white rounded-2xl shadow-lg border border-gray-200 h-fit xl:sticky xl:top-6 p-4">
      <div className="space-y-4">
        <div className="rounded-2xl border border-gray-200 bg-white p-3">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-2">
            Assistant
          </div>

          <div
            ref={assistantScrollRef}
            className="h-[320px] overflow-auto pr-1"
          >
            <div className="space-y-3">
              {pendingAction?.type === "search" && pendingAction?.query && (
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
                  <div className="text-xs font-medium text-indigo-700 uppercase tracking-wide mb-2">
                    Suggested Search
                  </div>
                  <div className="text-sm text-indigo-900 mb-3">
                    Search for: <span className="font-semibold">{pendingAction.query}</span>
                  </div>
                  <button
                    type="button"
                    onClick={applyPendingAction}
                    disabled={loading}
                    className={`w-full px-4 py-2 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 ${
                      loading ? "opacity-60 cursor-not-allowed" : ""
                    }`}
                  >
                    {loading ? "Searching..." : "Apply Search"}
                  </button>
                </div>
              )}

              {pendingAction?.type === "filter" && pendingAction?.filterKey && pendingAction?.value && (
                <div className="rounded-2xl border border-indigo-200 bg-indigo-50 p-3">
                  <div className="text-xs font-medium text-indigo-700 uppercase tracking-wide mb-2">
                    Suggested Filter
                  </div>
                  <div className="text-sm text-indigo-900 mb-3">
                    Show only <span className="font-semibold">{pendingAction.value}</span>{" "}
                    {pendingAction.filterKey === "brand" ? "products" : pendingAction.filterKey}.
                  </div>
                  <button
                    type="button"
                    onClick={applyPendingAction}
                    disabled={loading}
                    className={`w-full px-4 py-2 rounded-xl font-semibold text-white bg-indigo-600 hover:bg-indigo-700 ${
                      loading ? "opacity-60 cursor-not-allowed" : ""
                    }`}
                  >
                    Apply Filter
                  </button>
                </div>
              )}
          
              {chatMessages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`inline-block max-w-[85%] rounded-2xl px-3 py-2 text-sm ${
                      msg.role === "user"
                        ? "bg-indigo-50 text-indigo-900"
                        : "bg-gray-50 text-gray-700"
                    }`}
                  >
                    {msg.text}
                  </div>
                </div>
              ))}
            </div>
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
                if (!loading && !chatLoading) sendChatMessage();
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