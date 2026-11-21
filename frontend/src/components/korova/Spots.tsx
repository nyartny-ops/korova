// Brand mark: a Holstein tile — black spots on white, pink nose.
export function KorovaMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect x=".75" y=".75" width="30.5" height="30.5" rx="8.5" fill="#fff" stroke="#14161B" strokeWidth="1.5" />
      <path d="M5 5c4-1.5 9 0 9.5 3.6.5 3.4-3 5.4-6.6 5.9C5.2 15 3.6 13.4 3.6 11V7.2C3.6 6 4 5.3 5 5z" fill="#14161B" />
      <path
        d="M20.5 16.5c3.7-1.8 8-.6 8.7 2.7V26c0 1.8-1.2 3.2-3 3.2h-5.4c-2.8 0-4.6-2-4.4-4.7.2-3.8 1.3-6.4 4.1-8z"
        fill="#14161B"
      />
      <circle cx="23.6" cy="8" r="2.4" fill="#14161B" />
      <ellipse cx="10.5" cy="24" rx="4.6" ry="3" fill="#D6336C" />
    </svg>
  );
}
