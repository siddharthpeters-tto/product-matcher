import React, { useEffect, useMemo, useState } from "react";
import SearchPanel from "./SearchPanel.jsx";
import ResultsStage from "./ResultsStage.jsx";
import { searchOneFile, searchTextOnly } from "./ProductSearch.jsx";
import { DEFAULT_FILTERS, getBrand, getCategory } from "./Filters.jsx";

function buildBreakdown(items, key, limit = 5) {
  const counts = new Map();

  items.forEach((item) => {
    const value = item?.[key];
    if (!value) return;
    counts.set(value, (counts.get(value) || 0) + 1);
  });

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([value, count]) => ({ value, count }));
}


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
  const [pendingAction, setPendingAction] = useState(null);

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

    const lower = userPrompt.toLowerCase();

    if (
      pendingAction &&
      ["apply", "yes", "y", "do it", "go ahead", "confirm", "ok", "okay"].includes(lower)
    ) {
      setChatMessages((prev) => [...prev, { role: "user", text: userPrompt }]);
      setSearchText("");
      await applyPendingAction();
      return;
    }
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
            filters,
            topResults: results.slice(0, 5).map((item) => ({
              product_name: item.product_name,
              brand_name: item.brand_name,
              category: item.product_category,
              score: item.score,
            })),
            brandBreakdown: buildBreakdown(results, "brand_name"),
            categoryBreakdown: buildBreakdown(results, "product_category"),
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

      setPendingAction(data.action || null);

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


  async function applyPendingAction() {
    if (!pendingAction) return;

    if (pendingAction.type === "filter" && pendingAction.filterKey && pendingAction.value) {
      setFilters((prev) => ({
        ...prev,
        [pendingAction.filterKey]: pendingAction.value,
      }));

      setChatMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: `Applied ${pendingAction.filterKey} filter: ${pendingAction.value}.`,
        },
      ]);

      setPendingAction(null);
      return;
    }

    if (pendingAction.type === "search" && pendingAction.query) {
      setSearchText(pendingAction.query);
      setPendingAction(null);

      const userPrompt = pendingAction.query;

      if (loading) return;

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
  }  
  async function runSearch() {
    
    setFilters(DEFAULT_FILTERS);
    setPendingAction(null);
    
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
    setPendingAction(null);
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
            pendingAction={pendingAction}
            applyPendingAction={applyPendingAction}
          />
        </div>
      </div>
    </div>
  );
}