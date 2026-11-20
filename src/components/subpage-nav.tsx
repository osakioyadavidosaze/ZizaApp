"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle } from "lucide-react";

export function SubpageNav() {
  const pathname = usePathname();
  return (
    <header className="subpage-head">
      <Link href="/chat" className="small-brand"><span className="brand-mark"><MessageCircle size={17} /></span><span>Ziza<span className="brand-dot">.</span></span></Link>
      <nav aria-label="Main navigation">
        <Link className={pathname === "/chat" ? "current" : ""} href="/chat">Chats</Link>
        <Link className={pathname === "/stories" ? "current" : ""} href="/stories">Stories</Link>
        <Link className={pathname === "/settings" ? "current" : ""} href="/settings">Settings</Link>
      </nav>
    </header>
  );
}
