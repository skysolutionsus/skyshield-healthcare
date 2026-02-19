/**
 * Sky Solutions logo — uses the actual brand PNG asset
 */
export function SkyLogo({ className = "", size = 32 }: { className?: string; size?: number }) {
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src="/logo.png"
            alt="Sky Solutions"
            style={{ height: size, width: "auto" }}
            className={className}
        />
    );
}

export function SkyLogoFull({ className = "" }: { className?: string }) {
    return (
        <div className={`flex items-center ${className}`}>
            <SkyLogo size={28} />
        </div>
    );
}

