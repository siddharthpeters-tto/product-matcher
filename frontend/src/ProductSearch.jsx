const API_URL = "https://product-matcher-production-dc50.up.railway.app/search";

function groupResults(rows = []) {
  const grouped = rows.reduce((acc, item) => {
    const key = item.variant_id;
    if (!acc[key]) acc[key] = { ...item, images: [] };
    acc[key].images.push({
      image_id: item.image_id,
      image_path: item.image_path,
      score: item.score,
    });
    return acc;
  }, {});
  return Object.values(grouped);
}

export async function searchOneFile({
  apiUrl = API_URL,
  file,
  threshold = 0.25,
  semanticWeight = 0.5,
  text = "",
  conditions = [],
  removeBg = false,
  signal,
}) {

const queryParams = new URLSearchParams({
  threshold: String(threshold),
  semantic_weight: String(semanticWeight),
});

  if (text?.trim()) queryParams.append("text", text.trim());
  if (removeBg) queryParams.append("remove_bg", "1");

  if (Array.isArray(conditions) && conditions.length > 0) {
    queryParams.append("conditions_json", JSON.stringify(conditions));
  }

  const endpoint = `${apiUrl}?${queryParams.toString()}`;
  const options = { method: "POST", signal };

  if (file) {
    const formData = new FormData();
    formData.append("file", file);
    options.body = formData;
  }

  const res = await fetch(endpoint, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data?.message || "Search failed");
  }

  const rows = data.results || [];

  return {
    raw: rows,
    rawResultsCount: rows.length,
    results: rows,
    groupedResults: groupResults(rows),
    preview: data.preview || null,
    debug: data.debug || null,
  };
}

export async function searchTextOnly({
  apiUrl = API_URL,
  text,
  threshold = 0.25,
  semanticWeight = 0.5,
  conditions = [],
  signal,
}) {
  return searchOneFile({
    apiUrl,
    text,
    threshold,
    semanticWeight,
    conditions,
    signal,
  });
}

export async function runBatch({
  apiUrl = API_URL,
  items,
  threshold = 0.25,
  semanticWeight = 0.5,
  text = "",
  conditions = [],
  signal,
  onUpdate,
}) {
  const output = [];

  for (const item of items) {
    try {
      const data = await searchOneFile({
        apiUrl,
        file: item.file,
        text,
        threshold,
        semanticWeight,
        conditions,
        signal,
      });

      const enriched = {
        ...item,
        status: "done",
        rawResultsCount: data.results.length,
        allMatches: data.results,
        topMatches: data.groupedResults,
        errorMessage: "",
      };

      output.push(enriched);
      onUpdate?.(item.id, {
        status: "done",
        rawResultsCount: enriched.rawResultsCount,
        allMatches: enriched.allMatches,
        topMatches: enriched.topMatches,
        errorMessage: "",
      });
    } catch (e) {
      const failed = {
        ...item,
        status: "error",
        rawResultsCount: 0,
        allMatches: [],
        topMatches: [],
        errorMessage: e?.message || "Search failed",
      };

      output.push(failed);
      onUpdate?.(item.id, {
        status: "error",
        rawResultsCount: 0,
        allMatches: [],
        topMatches: [],
        errorMessage: e?.message || "Search failed",
      });
    }
  }

  return output;
}