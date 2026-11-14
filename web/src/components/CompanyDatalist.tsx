import { useEffect, useState } from "react";
import { api } from "../client.js";

let cache: string[] | null = null;

/** <datalist> of known companies for free-text company inputs (loaded once per page load). */
export function CompanyDatalist({ id }: { id: string }) {
  const [names, setNames] = useState<string[]>(cache ?? []);
  useEffect(() => {
    if (cache) return;
    let alive = true;
    api
      .companies()
      .then((r) => {
        cache = r.companies.map((c) => c.name);
        if (alive) setNames(cache);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);
  return (
    <datalist id={id}>
      {names.map((n) => (
        <option key={n} value={n} />
      ))}
    </datalist>
  );
}
