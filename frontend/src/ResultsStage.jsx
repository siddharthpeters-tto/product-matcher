import React from "react";

const API_BASE = "https://product-matcher-production-dc50.up.railway.app";

function resolveImageUrl(path) {
  if (!path || typeof path !== "string") return "";

  const trimmed = path.trim();
  if (!trimmed) return "";

  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }

  return `${API_BASE}${trimmed.startsWith("/") ? "" : "/"}${trimmed}`;
}

function getImagePath(item) {
  if (!item) return "";

  if (item?.images?.[0]?.image_path) return item.images[0].image_path;
  if (item?.images?.[0]?.url) return item.images[0].url;
  if (typeof item?.images?.[0] === "string") return item.images[0];

  if (item?.image_path) return item.image_path;
  if (item?.image_url) return item.image_url;
  if (item?.thumbnail) return item.thumbnail;
  if (item?.primary_image) return item.primary_image;
  if (item?.variant_image) return item.variant_image;
  if (item?.product_image) return item.product_image;

  return "";
}

function getMatchScore(item) {
  const imageScore = item?.images?.[0]?.score;
  const fallbackScore = item?.score;
  return ((imageScore ?? fallbackScore ?? 0) * 100).toFixed(1);
}

export default function ResultsStage({
  file,
  previewUrl,
  loading,
  results = [],
  rawResults = [],
  message,
  filters = { brand: "all", category: "all" },
  setFilters,
  filterOptions = { brands: [], categories: [] },
}) {
  return (
    <section>
      {file && (
        <div className="mb-6 rounded-2xl border border-gray-200 bg-gray-50 p-4">
          <div className="mb-3 text-sm font-semibold text-gray-900">
            Reference image
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_320px] gap-4 items-start">
            <div className="relative h-72 bg-white rounded-xl overflow-hidden border border-gray-200">
              <img
                src={previewUrl}
                alt="uploaded reference"
                className="absolute inset-0 w-full h-full object-contain"
              />
            </div>

            {rawResults.length > 0 && (
              <div className="rounded-2xl border border-gray-200 bg-white p-3">
                <div className="mb-3 text-xs font-medium uppercase tracking-wide text-gray-500">
                  Filters
                </div>

                <div className="space-y-3">
                  <div>
                    <label className="mb-1 block text-xs text-gray-500">
                      Brand
                    </label>
                    <select
                      value={filters.brand}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          brand: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="all">All brands</option>
                      {(filterOptions.brands || []).map((brand) => (
                        <option key={brand} value={brand}>
                          {brand}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block text-xs text-gray-500">
                      Category
                    </label>
                    <select
                      value={filters.category}
                      onChange={(e) =>
                        setFilters((prev) => ({
                          ...prev,
                          category: e.target.value,
                        }))
                      }
                      className="w-full rounded-xl border border-gray-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="all">All categories</option>
                      {(filterOptions.categories || []).map((category) => (
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
                    className="w-full rounded-xl border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Clear filters
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {message && !loading && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {message}
        </div>
      )}

      {loading ? (
        <div className="py-12 text-center text-sm text-gray-500">
          Searching...
        </div>
      ) : results.length === 0 ? (
        <div className="py-12">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-2xl font-semibold text-gray-900">
              Product Matcher
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              Upload a product image, type a description, or combine both to
              find matching products.
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
                Use the right panel to describe style, color, material, or
                shape.
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
          <div className="mb-6 text-sm font-medium text-gray-700">
            {results.length} matches found
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6">
            {results.map((item, i) => {
              const imagePath = getImagePath(item);
              const resolvedImage = resolveImageUrl(imagePath);
              const matchScore = getMatchScore(item);

              return (
                <div
                  key={`${item.variant_id || item.id || i}-${i}`}
                  className="p-4 border border-gray-200 rounded-xl shadow-sm bg-white"
                >
                  <a
                    href={item.product_url || "#"}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-indigo-700 font-semibold text-base underline truncate hover:text-indigo-900"
                  >
                    {item.variant_name || item.product_name || "Untitled Product"}
                  </a>

                  <div className="text-sm text-gray-600 truncate">
                    {item.brand_name || "Unknown brand"}
                  </div>

                  <div className="mt-2 text-sm font-medium text-indigo-700">
                    Match: {matchScore}%
                  </div>

                  {imagePath ? (
                    <img
                      src={resolvedImage}
                      alt={item.variant_name || item.product_name || "Product image"}
                      className="w-full h-40 object-contain rounded-md mt-3 bg-white border"
                      onError={() => {
                        console.error("IMAGE FAILED", {
                          item,
                          raw: imagePath,
                          resolved: resolvedImage,
                        });
                      }}
                    />
                  ) : (
                    <div className="w-full h-40 rounded-md mt-3 bg-gray-50 border flex items-center justify-center text-xs text-gray-400">
                      No image
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </section>
  );
}