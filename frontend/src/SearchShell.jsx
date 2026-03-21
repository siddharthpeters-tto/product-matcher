import React, { useEffect, useMemo, useState } from "react";
import SearchPanel from "./SearchPanel.jsx";
import ResultsStage from "./ResultsStage.jsx";
import { searchOneFile, searchTextOnly } from "./ProductSearch.jsx";
import { DEFAULT_FILTERS, getBrand, getCategory } from "./Filters.jsx";

export default function SearchShell() {
  const [searchText, setSearchText] = useState("");
  const [threshold, setThreshold] = useState(0.25);
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [message, setMessage] = useState("Ready to search");
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [results, setResults] = useState([]);
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "Upload an image or describe a product to begin." }
  ]);
  const [filters, setFilters] = useState(DEFAULT_FILTERS);

  const hasInput = useMemo(() => {
    return !!file || !!searchText.trim();
  }, [file, searchText]);

  const filterOptions = useMemo(() => {
    const brands = Array.from(
      new Set(results.map((item) => getBrand(item)).filter(Boolean))
    ).sort();

    const categories = Array.from(
      new Set(results.map((item) => getCategory(item)).filter(Boolean))
    ).sort();

    return { brands, categories };
  }, [results]);

  const filteredResults = useMemo(() => {
    return results.filter((item) => {
      const brandMatch =
        filters.brand === "all" || getBrand(item) === filters.brand;

      const categoryMatch =
        filters.category === "all" || getCategory(item) === filters.category;

      return brandMatch && categoryMatch;
    });
  }, [results, filters]);

  useEffect(() => {
    if (!loading && results.length > 0) {
      window.scrollTo({ top: 0, behavior: "auto" });
    }
  }, [loading, results]);

  async function sendChatMessage() {
    const userPrompt = searchText.trim();
    if (!userPrompt || chatLoading) return;

    const nextHistory = [...chatMessages, { role: "user", text: userPrompt }];
    setChatMessages(nextHistory);
    setSearchText("");
    setChatLoading(true);

    try {
      const res = await fetch("https://product-matcher-production-dc50.up.railway.app/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userPrompt,
          history: nextHistory.map(({ role, text }) => ({
            role,
            content: text,
          })),
          context: {
            hasImage: !!file,
            resultCount: results.length,
            filters: filters,
          },
        }),
      });
      if (!res.ok) {
        throw new Error("Assistant response failed");
      }

      const data = await res.json();

      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: data.reply || "I’m not sure how to respond to that yet.",
        },
      ]);
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: e?.message || "Something went wrong.",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  }

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
      setChatMessages((prev) => [...prev, { role: "assistant", text: err }]);
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
    setFilters(DEFAULT_FILTERS);
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
              results={filteredResults}
              rawResults={results}
              message={message}
              filters={filters}
              setFilters={setFilters}
              filterOptions={filterOptions}
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
            chatLoading={chatLoading}
            message={message}
            runSearch={runSearch}
            sendChatMessage={sendChatMessage}
            clearAll={clearAll}
            handleFileChange={handleFileChange}
            chatMessages={chatMessages}
            filters={filters}
            setFilters={setFilters}
            filterOptions={filterOptions}
          />
        </div>
      </div>
    </div>
  );
}