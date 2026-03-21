import React from "react";

export default function ResultsStage({
    file,
    previewUrl,
    loading,
    results,
    rawResults,
    filters,
    setFilters,
    filterOptions,
  }) {
  return (
    <section>
      {file && (
        <div className="mb-6 rounded-2xl border border-gray-200 bg-gray-50 p-4">
          <div className="text-sm font-semibold text-gray-900 mb-3">
            Reference image
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
            <div className="relative h-72 bg-white rounded-xl overflow-hidden border border-gray-200">
              <img
                src={previewUrl}
                alt="uploaded"
                className="absolute inset-0 w-full h-full object-contain"
              />
            </div>

            {rawResults.length > 0 && (
              <div className="rounded-2xl border border-gray-200 bg-white p-3">
                <div className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-3">
                  Filters
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Brand</label>
                    <select
                      value={filters.brand}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, brand: e.target.value }))
                      }
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="all">All brands</option>
                      {filterOptions.brands.map((brand) => (
                        <option key={brand} value={brand}>
                          {brand}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-xs text-gray-500 mb-1">Category</label>
                    <select
                      value={filters.category}
                      onChange={(e) =>
                        setFilters((prev) => ({ ...prev, category: e.target.value }))
                      }
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="all">All categories</option>
                      {filterOptions.categories.map((category) => (
                        <option key={category} value={category}>
                          {category}
                        </option>
                      ))}
                    </select>
                  </div>

                  <button
                    type="button"
                    onClick={() =>
                      setFilters({
                        brand: "all",
                        category: "all",
                      })
                    }
                    className="w-full px-3 py-2 rounded-xl border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Clear filters
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="text-center text-sm text-gray-500 py-12">
          Searching...
        </div>
      ) : results.length === 0 ? (
        <div className="py-12">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-2xl font-semibold text-gray-900">
              Product Matcher
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Upload a product image, type a description, or combine both to find matching products.
            </p>
          </div>

          <div className="mt-8 grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold text-gray-900">
                Upload an image
              </div>
              <div className="mt-1 text-sm text-gray-600">
                Add a reference photo of a chair, sofa, desk, or other product.
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold text-gray-900">
                Describe the product
              </div>
              <div className="mt-1 text-sm text-gray-600">
                Use the right panel to describe style, color, material, or shape.
              </div>
            </div>

            <div className="rounded-xl border border-gray-200 bg-gray-50 p-4">
              <div className="text-sm font-semibold text-gray-900">
                Review matches
              </div>
              <div className="mt-1 text-sm text-gray-600">
                Results will appear here once you search.
              </div>
            </div>
          </div>
        </div>
      ) : (
        <section className="mt-8">
          <div className="mb-6">
            <div className="text-sm font-medium text-gray-700">
              {results.length} matches found
            </div>
          </div>
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
        </section>
      )}
    </section>
  );
}