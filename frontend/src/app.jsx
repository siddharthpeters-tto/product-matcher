import React from "react";
import ProductSearch from "./ProductSearch";

export default function App() {
  return (
    <main className="p-4 sm:p-8 font-inter">
      <h1 className="text-3xl sm:text-4xl font-semibold mb-6 text-gray-800 text-center">
        🕵️‍♀️ Product Matcher
      </h1>
      <ProductSearch />
    </main>
  );
}
