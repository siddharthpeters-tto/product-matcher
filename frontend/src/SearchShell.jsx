import React, { useEffect, useMemo, useState } from "react";
import SearchPanel from "./SearchPanel.jsx";
import ResultsStage from "./ResultsStage.jsx";
import { getBrand, getCategory } from "./Filters.jsx";
import { searchOneFile, searchTextOnly } from "./ProductSearch.jsx";

export default function SearchShell() {
  const [searchText, setSearchText] = useState("");
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", text: "hello" },
  ]);
  const [filters, setFilters] = useState({ brand: "all", category: "all" });
  const [pendingAction, setPendingAction] = useState(null);
  const [file, setFile] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [message, setMessage] = useState("Ready to search");
  const [loading, setLoading] = useState(false);
  const [chatLoading, setChatLoading] = useState(false);
  const [threshold, setThreshold] = useState(0.25);
  const [results, setResults] = useState([]);
  const API_BASE = "https://product-matcher-production-dc50.up.railway.app";

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

  async function runSearch(overrideQuery = null) {
    const safeOverride =
      typeof overrideQuery === "string" ? overrideQuery : null;

    const query = (safeOverride ?? searchText).trim();

    if (!query && !file) {
      setMessage("Enter a search term or upload an image.");
      return;
    }

    setLoading(true);
    setMessage("Searching...");
    setPendingAction(null);

    try {
      let data;

      if (file) {
        data = await searchOneFile({
          file,
          text: query,
          threshold,
        });
      } else {
        data = await searchTextOnly({
          text: query,
          threshold,
        });
      }

      setResults(data.results || []);
      setMessage(`Found ${data.results?.length || 0} results.`);
    } catch (err) {
      setMessage(`Search failed: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function sendChatMessage() {
    const userPrompt = searchText.trim();
    if (!userPrompt || chatLoading) return;

    setChatMessages((prev) => [...prev, { role: "user", text: userPrompt }]);
    setSearchText("");
    setChatLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: userPrompt,
          context: {
            hasImage: !!file,
            resultCount: results.length,
            filters,
            topResults: results.slice(0, 8).map((r) => ({
              id: r.id,
              name: r.name,
              brand: getBrand(r),
              category: getCategory(r),
              score: r.score,
            })),
            brandBreakdown: filterOptions.brands.map((b) => ({
              value: b,
              count: results.filter((r) => getBrand(r) === b).length,
            })),
            categoryBreakdown: filterOptions.categories.map((c) => ({
              value: c,
              count: results.filter((r) => getCategory(r) === c).length,
            })),
          },
        }),
      });

      if (!res.ok) {
        throw new Error(`Chat request failed: ${res.status}`);
      }

      const data = await res.json();

      setChatMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply || "Okay." },
      ]);

      const nextAction = data.action || null;

      if (pendingAction && nextAction && nextAction.type) {
        await applyPendingAction(nextAction);
        return;
      }

      setPendingAction(nextAction);
    } catch (err) {
      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: "Sorry, something went wrong while processing that request.",
        },
      ]);
    } finally {
      setChatLoading(false);
    }
  }
  function clearAll() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
    setSearchText("");
    setResults([]);
    setMessage("Ready to search");
    setFilters({ brand: "all", category: "all" });
    setPendingAction(null);
    setChatMessages([{ role: "assistant", text: "hello" }]);
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

  async function applyPendingAction(actionOverride = null) {
    const action = actionOverride || pendingAction;
    if (!action) return;

    if (action.type === "filter" && action.filterKey && action.value) {
      setFilters((prev) => ({
        ...prev,
        [action.filterKey]: action.value,
      }));

      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Applied ${action.filterKey} filter: ${action.value}.`,
        },
      ]);

      setPendingAction(null);
      return;
    }

    if (action.type === "search" && action.query) {
      setPendingAction(null);
      setFilters({ brand: "all", category: "all" });
      await runSearch(action.query);
    }
  }

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", padding: 24 }}>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) 380px",
          gap: 24,
          alignItems: "start",
          maxWidth: 1600,
          margin: "0 auto",
        }}
      >
        <div style={{ background: "white", borderRadius: 16, padding: 24 }}>
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
        </div>

        <div>
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
            pendingAction={pendingAction}
            applyPendingAction={applyPendingAction}
          />
        </div>
      </div>
    </div>
  );
}