/** MailMe mark: three equaliser bars (Contoso is a pro-audio house) on a lit amber key. */
import { useId } from "react";

export function BrandMark({ size = 28 }: { size?: number }) {
  // A unique gradient id per mark: the sidebar's copy is display:none on phones, and a gradient referenced from a
  // hidden subtree does not paint.
  const id = `mm-key${useId().replace(/:/g, "")}`;
  return (
    <svg className="brandmark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FFC45E" />
          <stop offset="1" stopColor="#FFA41F" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill={`url(#${id})`} />
      <rect x="8" y="14" width="4" height="10" rx="2" fill="#15171B" />
      <rect x="14" y="8" width="4" height="16" rx="2" fill="#15171B" />
      <rect x="20" y="11" width="4" height="13" rx="2" fill="#15171B" />
    </svg>
  );
}
