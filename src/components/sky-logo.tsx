/**
 * SkyShield logo — uses the actual brand PNG asset
 */
export function SkyLogo({
    className = "",
    size = 32,
    light = false
}: {
    className?: string;
    size?: number;
    light?: boolean;
}) {
    return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
            src={light ? "/logo-light.png" : "/logo.png"}
            alt="SkyShield"
            style={{ height: size, width: "auto" }}
            className={className}
        />
    );
}

export function SkyLogoFull({ className = "", light = false }: { className?: string, light?: boolean }) {
    return (
        <div className={`flex items-center ${className}`}>
            <SkyLogo size={36} light={light} />
        </div>
    );
}
