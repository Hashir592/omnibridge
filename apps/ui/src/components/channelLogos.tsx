import { ShoppingCart } from 'lucide-react';
import type { Channel } from '../mocks/types.ts';

/**
 * Small channel marks (18 px) used wherever a channel is named, always next to its name, so the
 * mark is decorative (aria-hidden). Inline SVG: no image requests and nothing for the CSP to allow.
 * Brand colours are used only inside these marks, never as UI colours (DIRECTION §2).
 */

function AmazonMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden>
      <rect width="18" height="18" rx="4" fill="#232F3E" />
      <text
        x="9"
        y="11"
        textAnchor="middle"
        fontSize="11"
        fontWeight="700"
        fontFamily="Arial, Helvetica, sans-serif"
        fill="#FFFFFF"
      >
        a
      </text>
      {/* the smile, with its arrow tip */}
      <path
        d="M4.2 12.6 Q9 15.2 13.6 12.4"
        stroke="#FF9900"
        strokeWidth="1.3"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M12.2 11.9 L13.9 12.2 L13.4 13.8"
        stroke="#FF9900"
        strokeWidth="1.1"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function EbayMark() {
  return (
    <svg viewBox="0 0 18 18" className="size-[18px]" aria-hidden>
      <rect x="0.5" y="0.5" width="17" height="17" rx="3.5" fill="#FFFFFF" stroke="#DDE1E7" />
      <text
        x="9"
        y="11.6"
        textAnchor="middle"
        fontSize="7.6"
        fontWeight="700"
        letterSpacing="-0.5"
        fontFamily="Arial, Helvetica, sans-serif"
      >
        <tspan fill="#E53238">e</tspan>
        <tspan fill="#0064D2">b</tspan>
        <tspan fill="#F5AF02">a</tspan>
        <tspan fill="#86B817">y</tspan>
      </text>
    </svg>
  );
}

/**
 * The "own website" channel: a plain, generic cart in the UI's own graphite. It is not any shop's
 * logo; a per-workspace logo arrives with the website connection in M11 (ADR-057).
 */
function WebsiteMark() {
  return (
    <span
      className="grid size-[18px] place-items-center rounded-[4px] border border-border bg-card text-ink-muted"
      aria-hidden
    >
      <ShoppingCart className="size-3" strokeWidth={2} />
    </span>
  );
}

export function ChannelLogo({ channel }: { channel: Channel }) {
  if (channel === 'amazon') return <AmazonMark />;
  if (channel === 'ebay') return <EbayMark />;
  return <WebsiteMark />;
}
