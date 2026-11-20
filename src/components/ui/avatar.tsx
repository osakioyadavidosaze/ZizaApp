import { UserRound } from "lucide-react";

type AvatarProps = {
  name: string;
  url?: string | null;
  className?: string;
};

export function Avatar({ name, url, className = "" }: AvatarProps) {
  if (url) {
    return <span className={`avatar ${className}`}><img src={url} alt="" /></span>;
  }
  const initials = name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]?.toUpperCase() ?? "").join("");
  return <span className={`avatar ${className}`} aria-label={name}>{initials || <UserRound size={17} />}</span>;
}
