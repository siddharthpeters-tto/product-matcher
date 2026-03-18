import React, { useState } from "react";
import Filters, { DEFAULT_FILTERS } from "./Filters.jsx";

export default function UI() {
  const [filters] = useState(DEFAULT_FILTERS);

  return (
    <div style={{ padding: 24, background: "white", color: "black" }}>
      UI mounted
    </div>
  );
}