import React, { useState } from "react";
import Filters, { DEFAULT_FILTERS } from "./Filters.jsx";
import { searchOneFile, searchTextOnly, runBatch } from "./ProductSearch.jsx";
import { exportCartToPdf } from "./exportpdf.jsx";
import { pickFolderImages } from "./uploads/folder_Upload.js";

export default function UI() {
  const [filters] = useState(DEFAULT_FILTERS);

  console.log(
    searchOneFile,
    searchTextOnly,
    runBatch,
    exportCartToPdf,
    pickFolderImages
  );

  return (
    <div style={{ padding: 24, background: "white", color: "black" }}>
      UI mounted
    </div>
  );
}