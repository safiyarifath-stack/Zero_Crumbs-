import { useState } from 'react';
import { Leaf } from 'lucide-react';

interface FoodImageProps {
  src?: string;
  alt: string;
  className?: string;
}

export function FoodImage({ src, alt, className = 'w-full h-full object-cover' }: FoodImageProps) {
  const [failed, setFailed] = useState(false);

  const isSafeSrc =
    typeof src === 'string' &&
    (src.startsWith('/src/assets/images/') ||
      src.startsWith('https://') ||
      src.startsWith('data:image/jpeg;base64,') ||
      src.startsWith('data:image/png;base64,') ||
      src.startsWith('data:image/webp;base64,'));

  if (!isSafeSrc || failed) {
    return (
      <div
        className={`flex flex-col items-center justify-center bg-gradient-to-br from-[#EEF3EC] via-[#F7F3EC] to-[#FBE8DC] text-[#355E4B] p-3 ${className}`}
        aria-label={alt}
      >
        <Leaf className="w-6 h-6 mb-1 opacity-75" />
        <span className="text-xs font-medium text-center line-clamp-1 max-w-[90%] text-[#2D4739]">
          {alt}
        </span>
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
