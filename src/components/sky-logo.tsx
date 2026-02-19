/**
 * Sky Solutions logo — uses the actual brand PNG asset
 */
import Image from "next/image";

export function SkyLogo({ className = "", size = 32 }: { className?: string; size?: number }) {
    return (
        <Image
            src="/logo.png"
            alt="Sky Solutions"
            width={size * 3}
            height={size}
            className={className}
            style={{ width: "auto", height: size }}
            priority
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
