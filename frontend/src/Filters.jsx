// Filters.jsx
import React from "react";

export const DEFAULT_FILTERS = { brand: "all", category: "all" };

export default function Filters({
  options = { brands: [], categories: [] },
  filters,
  onChange,
  onClear,
  resultsCount,
}) {
  const activeCount = (filters.brand !== "all") + (filters.category !== "all");

  return (
    <div className="border border-gray-200 rounded-xl p-4 bg-white shadow-sm">
      <div className="flex items-center justify-between mb-3">
        <div className="text-sm font-semibold text-gray-800">
          Filters{" "}
          {activeCount ? (
            <span className="text-gray-500">({activeCount})</span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={onClear}
          className="text-sm underline text-gray-600 hover:text-gray-900"
        >
          Clear
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {/* Brand */}
        <div>
          <div className="text-xs font-semibold text-gray-600 mb-1">Brand</div>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={filters.brand}
            onChange={(e) => onChange({ ...filters, brand: e.target.value })}
          >
            <option value="all">All</option>
            {options.brands.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </div>

        {/* Category */}
        <div>
          <div className="text-xs font-semibold text-gray-600 mb-1">Category</div>
          <select
            className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
            value={filters.category}
            onChange={(e) => onChange({ ...filters, category: e.target.value })}
          >
            <option value="all">All</option>
            {options.categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      </div>

      {typeof resultsCount === "number" && (
        <div className="mt-3 text-xs text-gray-600">
          Showing <span className="font-semibold">{resultsCount}</span> results
        </div>
      )}
    </div>
  );
}

/** Helpers: match your backend response keys */
export function getBrand(r) {
  return (r?.brand_name ?? r?.brand ?? "").toString().trim();
}

// Your backend sample shows product_category, not category
export function getCategory(r) {
  return (r?.product_category ?? r?.category ?? "").toString().trim();
}