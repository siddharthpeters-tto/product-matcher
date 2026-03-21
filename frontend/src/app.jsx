import { useState } from "react";
import UI from "./UI";
import SearchShell from "./SearchShell";

function App() {
  const [useLegacy, setUseLegacy] = useState(false);

  return (
    <>
      <div className="fixed top-4 right-4 z-50">
        <button
          onClick={() => setUseLegacy((v) => !v)}
          className="px-3 py-2 rounded-lg bg-black text-white text-sm shadow"
        >
          {useLegacy ? "Use New UI" : "Use Legacy UI"}
        </button>
      </div>

      {useLegacy ? <UI /> : <SearchShell />}
    </>
  );
}

export default App;