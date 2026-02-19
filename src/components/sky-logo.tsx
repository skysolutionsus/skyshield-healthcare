/**
 * Sky Solutions logo — paper airplane mark
 * Recreated as an SVG component from the brand assets
 */
export function SkyLogo({ className = "", size = 32 }: { className?: string; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
            className={className}
        >
            {/* Main airplane body */}
            <path
                d="M4 24L20 18L44 8L28 30L4 24Z"
                fill="url(#skyGrad1)"
            />
            {/* Bottom wing shadow */}
            <path
                d="M20 18L28 30L20 40L20 18Z"
                fill="url(#skyGrad2)"
            />
            {/* Top highlight */}
            <path
                d="M4 24L20 18L44 8L4 24Z"
                fill="url(#skyGrad3)"
                opacity="0.6"
            />
            <defs>
                <linearGradient id="skyGrad1" x1="4" y1="8" x2="44" y2="30" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#1565C0" />
                    <stop offset="1" stopColor="#2196F3" />
                </linearGradient>
                <linearGradient id="skyGrad2" x1="20" y1="18" x2="28" y2="40" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#0D47A1" />
                    <stop offset="1" stopColor="#1565C0" />
                </linearGradient>
                <linearGradient id="skyGrad3" x1="4" y1="8" x2="44" y2="24" gradientUnits="userSpaceOnUse">
                    <stop stopColor="#42A5F5" />
                    <stop offset="1" stopColor="#2196F3" />
                </linearGradient>
            </defs>
        </svg>
    );
}

export function SkyLogoFull({ className = "" }: { className?: string }) {
    return (
        <div className={`flex items-center gap-2.5 ${className}`}>
            <SkyLogo size={28} />
            <div className="flex items-baseline gap-1.5">
                <span className="text-base font-bold tracking-tight text-white">SKY</span>
                <span className="text-base font-light tracking-tight text-[var(--sky-light)]">SOLUTIONS</span>
            </div>
        </div>
    );
}
