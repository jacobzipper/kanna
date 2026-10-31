import { NavLink, useLocation } from "react-router-dom"
import { BookOpen, Hash, LayoutGrid, Server, Sparkles } from "lucide-react"
import { cn } from "../lib/utils"

const TABS = [
  { to: "/home", label: "Home", icon: Sparkles, match: (p: string) => p === "/" || p === "/home" },
  { to: "/spaces", label: "Spaces", icon: LayoutGrid, match: (p: string) => p.startsWith("/spaces") },
  { to: "/channels", label: "Channels", icon: Hash, match: (p: string) => p.startsWith("/channels") || p.startsWith("/c/") },
  { to: "/library", label: "Library", icon: BookOpen, match: (p: string) => p.startsWith("/library") },
  { to: "/infra", label: "Infra", icon: Server, match: (p: string) => p.startsWith("/infra") },
]

/** Phone tab bar. Hidden inside a chat transcript, which has its own composer. */
export function BottomTabs() {
  const { pathname } = useLocation()
  if (pathname.startsWith("/chat/") || pathname.startsWith("/settings") || pathname.startsWith("/terminal")) return null
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur supports-[backdrop-filter]:bg-background/80 md:hidden">
      <div className="mx-auto flex h-[4.5rem] max-w-lg items-stretch">
        {TABS.map((t) => {
          const active = t.match(pathname)
          return (
            <NavLink key={t.to} to={t.to} className={cn("flex flex-1 flex-col items-center justify-center gap-1 text-[11px]", active ? "text-foreground" : "text-muted-foreground")}>
              <span className={cn("flex h-7 w-12 items-center justify-center rounded-full transition-colors", active && "bg-muted")}>
                <t.icon className={cn("size-[19px]", active && "text-logo")} />
              </span>
              {t.label}
            </NavLink>
          )
        })}
      </div>
    </nav>
  )
}
