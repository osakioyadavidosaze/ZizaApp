"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import { BrowserQRCodeReader } from "@zxing/browser";
import { Camera, Check, LoaderCircle, Search, UserPlus, X } from "lucide-react";
import { formatZizaNumber, normalizeZizaNumber } from "@/lib/auth";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import type { Profile } from "@/lib/database.types";
import { Avatar } from "@/components/ui/avatar";

type ContactSearchDialogProps = {
  onClose: () => void;
  onContact: (person: Profile) => Promise<void>;
  onRequestSent: () => Promise<void>;
};

export function ContactSearchDialog({ onClose, onContact, onRequestSent }: ContactSearchDialogProps) {
  const supabase = getSupabaseBrowserClient();
  const [number, setNumber] = useState("");
  const [person, setPerson] = useState<Profile | null>(null);
  const [status, setStatus] = useState("");
  const [requestSent, setRequestSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [cameraError, setCameraError] = useState("");
  const videoRef = useRef<HTMLVideoElement>(null);
  const stopScannerRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopScannerRef.current?.(), []);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPerson(null);
    setStatus("");
    setRequestSent(false);
    setCameraError("");
    const zizaNumber = normalizeZizaNumber(number);
    if (!zizaNumber) {
      setStatus("Enter the full 10-digit Ziza Number.");
      return;
    }
    if (!supabase) {
      setStatus("Supabase isn’t configured yet.");
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("lookup_ziza_number", { p_ziza_number: zizaNumber });
    setBusy(false);
    if (error) {
      setStatus(error.message);
      return;
    }
    const match = data[0];
    if (!match) {
      setStatus("No Ziza account found for that exact number.");
      return;
    }
    setPerson({
      ...match,
      id: match.user_id,
      hide_online_status: false,
      read_receipts_enabled: true,
      disappearing_messages: "off",
      created_at: "",
      updated_at: "",
    });
  }

  async function addPerson() {
    if (!supabase || !person) return;
    setBusy(true);
    setRequestSent(true);
    setStatus("Sending request…");
    const { error } = await supabase.rpc("send_contact_request", { p_ziza_number: person.ziza_number });
    if (!error) {
      setStatus("Request sent. You can start chatting when they accept.");
      setBusy(false);
      await onRequestSent();
      return;
    }

    if (error.message.toLowerCase().includes("already exists")) {
      const { data: authData, error: authError } = await supabase.auth.getUser();
      if (authError || !authData.user) {
        setRequestSent(false);
        setBusy(false);
        setStatus(authError?.message ?? "Authentication is required to send a request.");
        return;
      }
      const { data: relationship, error: relationshipError } = await supabase
        .from("contacts")
        .select("*")
        .or(`and(user_id.eq.${authData.user.id},contact_id.eq.${person.id}),and(user_id.eq.${person.id},contact_id.eq.${authData.user.id})`)
        .maybeSingle();
      if (relationshipError) {
        setRequestSent(false);
        setBusy(false);
        setStatus(relationshipError.message);
        return;
      }
      if (relationship?.status === "pending") {
        setStatus("This request is already pending.");
        setBusy(false);
        await onRequestSent();
        return;
      }
      if (relationship?.status === "accepted") {
        const { data: conversationId, error: conversationError } = await supabase.rpc("create_direct_conversation", { p_contact_id: person.id });
        if (!conversationError && conversationId) {
          await onContact(person);
          return;
        }
        if (conversationError) {
          setRequestSent(false);
          setBusy(false);
          setStatus(conversationError.message);
          return;
        }
      }
    }
    setRequestSent(false);
    setBusy(false);
    setStatus(error.message);
  }

  async function startScan() {
    setCameraError("");
    setScanning(true);
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    if (!videoRef.current) {
      setScanning(false);
      setCameraError("The camera preview could not be opened.");
      return;
    }
    try {
      const reader = new BrowserQRCodeReader();
      const controls = await reader.decodeFromVideoDevice(undefined, videoRef.current, (result) => {
        if (!result) return;
        const text = result.getText();
        const match = text.match(/(?:ziza:\/\/add\/|\/add\/)?(\d{3}-?\d{3}-?\d{4})$/i);
        const parsed = match?.[1] ?? text;
        if (normalizeZizaNumber(parsed)) {
          setNumber(formatZizaNumber(parsed));
          controlsStop();
          stopScannerRef.current = null;
          setScanning(false);
        }
      });
      stopScannerRef.current = () => controls.stop();
    } catch (caught) {
      setScanning(false);
      setCameraError(caught instanceof Error ? caught.message : "Could not start the camera.");
    }

    function controlsStop() {
      stopScannerRef.current?.();
    }
  }

  function stopScan() {
    stopScannerRef.current?.();
    stopScannerRef.current = null;
    setScanning(false);
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="modal-card" role="dialog" aria-modal="true" aria-labelledby="find-person-title">
        <div className="modal-head">
          <div><h2 id="find-person-title">Find your people</h2><p>Search by their exact Ziza Number or scan their QR code.</p></div>
          <button className="icon-button" aria-label="Close" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={(event) => void search(event)}>
          <div className="modal-form-row">
            <input autoFocus inputMode="numeric" autoComplete="off" maxLength={12} placeholder="000-000-0000" value={number} onChange={(event) => { setNumber(event.target.value); setPerson(null); setStatus(""); setRequestSent(false); }} />
            <button type="submit" className="primary-button" disabled={busy || !normalizeZizaNumber(number)}>{busy ? <LoaderCircle size={15} className="spin-icon" /> : <Search size={15} />} Search</button>
          </div>
        </form>
        <button className="scanner-toggle" type="button" onClick={scanning ? stopScan : () => void startScan()}><Camera size={14} />{scanning ? "Stop camera" : "Scan a QR code"}</button>
        {scanning && <video ref={videoRef} className="camera-frame" muted playsInline />}
        {cameraError && <p className="modal-error">{cameraError}</p>}
        {person && (
          <div className="lookup-result">
            <Avatar name={person.display_name} url={person.avatar_url} />
            <div className="lookup-result-main"><strong>{person.display_name}</strong><span>@{person.username} · {formatZizaNumber(person.ziza_number)}</span></div>
            <button className="primary-button request-button" onClick={() => void addPerson()} disabled={busy || requestSent}>{requestSent ? <Check size={14} /> : <UserPlus size={14} />}{requestSent ? "Requested" : "Add"}</button>
          </div>
        )}
        {status && <p className={`modal-error ${requestSent ? "modal-success" : ""}`} role="status">{status}</p>}
      </section>
    </div>
  );
}
