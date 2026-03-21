import React, { useEffect, useMemo, useState } from "react";
import SearchPanel from "./SearchPanel.jsx";
import ResultsStage from "./ResultsStage.jsx";
import { searchOneFile, searchTextOnly } from "./ProductSearch.jsx";


export default function SearchShell() {
  const [searchText, setSearchText] = useState("");
  const [threshold, setThreshold] = useState(0.25);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("Ready to search");
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [results, setResults] = useState([]);
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Upload an image or describe a product to begin." }
  ]);

  const hasInput = useMemo(() => {
    return !!file || !!searchText.trim();
  }, [file, searchText]);

  useEffect(() => {
    if (!loading && results.length > 0) {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }, [loading, results]);
  
  async function runSearch() {
    if (!hasInput || loading) return;

    const userPrompt = searchText.trim();

    if (userPrompt) {
      setChatMessages((prev) => [...prev, { role: "user", text: userPrompt }]);
    }

    setSearchText("");
    setLoading(true);
    setMessage("Searching...");
    setResults([]);

    try {
      const out = file
        ? await searchOneFile({
            file,
            text: userPrompt,
            threshold,
          })
        : await searchTextOnly({
            text: userPrompt,
            threshold,
          });

      const nextResults = out.groupedResults || [];
      setResults(nextResults);
      setMessage("");
    } catch (e) {
      const err = e?.message || "Search failed";
      setMessage(err);
      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: err }
      ]);
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
    setChatMessages([
      { role: "assistant", text: "Upload an image or describe a product to begin." }
    ]);
  }

  return (
    <div className="min-h-screen bg-slate-50">
      <div className="mx-auto max-w-[1600px] px-4 py-6">
        <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px] gap-6">
          <main className="bg-white rounded-2xl shadow-lg p-6">
            <ResultsStage
              file={file}
              previewUrl={previewUrl}
              loading={loading}
              results={results}
              message={message}
            />
          </main>
          <SearchPanel
            file={file}
            previewUrl={previewUrl}
            searchText={searchText}
            setSearchText={setSearchText}
            threshold={threshold}
            setThreshold={setThreshold}
            loading={loading}
            message={message}
            runSearch={runSearch}
            clearAll={clearAll}
            handleFileChange={handleFileChange}
            chatMessages={chatMessages}
          />      
        </div>
      </div>
    </div>
  );
}