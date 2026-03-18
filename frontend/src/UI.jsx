import React, { useState } from "react";
import Filters, { DEFAULT_FILTERS } from "./Filters.jsx";
import { searchOneFile, searchTextOnly, runBatch } from "./ProductSearch.jsx";

export default function UI() {
  const [filters] = useState(DEFAULT_FILTERS);

  console.log(searchOneFile, searchTextOnly, runBatch);

  return (
    <div style={{ padding: 24, background: "white", color: "black" }}>
      UI mounted
    </div>
  );
}