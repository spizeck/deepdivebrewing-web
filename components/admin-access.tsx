"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatAdminDate, formatAdminDateTime } from "@/lib/admin-format";
import type { AdminRole, AdminUserView, AdminInvitationView } from "@/lib/types";
import type { User } from "firebase/auth";

interface AdminAccessPanelProps {
  user: User;
  onStatusMessage: (message: string) => void;
}

interface AdminListResponse {
  ok: boolean;
  users?: AdminUserView[];
  invitations?: AdminInvitationView[];
  error?: string;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function AdminAccessPanel({ user, onStatusMessage }: AdminAccessPanelProps) {
  const [admins, setAdmins] = useState<AdminUserView[]>([]);
  const [invitations, setInvitations] = useState<AdminInvitationView[]>([]);
  const [loading, setLoading] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AdminRole>("admin");
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/users", {
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as AdminListResponse;
      if (!res.ok || !data.ok) {
        onStatusMessage(data.error ?? "Failed to load administrators.");
        return;
      }
      setAdmins(data.users ?? []);
      setInvitations(data.invitations ?? []);
    } catch (error) {
      console.error(error);
      onStatusMessage("Failed to load administrators.");
    } finally {
      setLoading(false);
    }
  }, [user, onStatusMessage]);

  useEffect(() => {
    load();
  }, [load]);

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const email = inviteEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      onStatusMessage("Please enter a valid email address.");
      return;
    }
    setActionInProgress("invite");
    try {
      const idToken = await user.getIdToken();
      const res = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email, role: inviteRole }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        emailSent?: boolean;
        warning?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        onStatusMessage(data.error ?? "Invitation failed.");
        return;
      }
      setInviteEmail("");
      if (data.emailSent) {
        onStatusMessage(`Invitation created and email sent to ${email} as ${inviteRole}.`);
      } else {
        onStatusMessage(data.warning ?? "Invitation created, but the email could not be sent.");
      }
      await load();
    } catch (error) {
      console.error(error);
      onStatusMessage("Invitation failed. Please try again.");
    } finally {
      setActionInProgress(null);
    }
  }

  async function resend(invitation: AdminInvitationView) {
    if (invitation.status !== "pending") return;
    const actionKey = `resend-${invitation.id}`;
    if (actionInProgress === actionKey) return;

    setActionInProgress(actionKey);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/admin/invitations/${invitation.id}/resend`, {
        method: "POST",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as {
        ok?: boolean;
        emailResent?: boolean;
        warning?: string;
        error?: string;
      };
      if (!res.ok || !data.ok) {
        onStatusMessage(data.error ?? "Resend failed.");
        return;
      }
      if (data.emailResent) {
        onStatusMessage("Invitation email resent.");
      } else {
        onStatusMessage(
          data.warning ??
            "The email could not be resent. The invitation remains pending."
        );
      }
      await load();
    } catch (error) {
      console.error(error);
      onStatusMessage("Resend failed. Please try again.");
    } finally {
      setActionInProgress(null);
    }
  }

  async function updateAdmin(
    target: AdminUserView,
    updates: Partial<Pick<AdminUserView, "role" | "status">>
  ) {
    const actionKey = `update-${target.uid}`;
    if (actionInProgress === actionKey) return;
    if (updates.role === target.role && updates.status === target.status) return;

    const confirmMsg =
      updates.status === "disabled"
        ? `Disable administrator access for ${target.email}?`
        : updates.status === "active"
          ? `Reactivate administrator access for ${target.email}?`
          : `Change ${target.email} role to ${updates.role}?`;

    if (!window.confirm(confirmMsg)) return;

    setActionInProgress(actionKey);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${target.uid}`, {
        method: "PATCH",
        headers: {
          Authorization: `Bearer ${idToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(updates),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        onStatusMessage(data.error ?? "Update failed.");
        return;
      }
      onStatusMessage("Administrator updated. Ask them to sign out and back in if their role changed.");
      await load();
    } catch (error) {
      console.error(error);
      onStatusMessage("Update failed. Please try again.");
    } finally {
      setActionInProgress(null);
    }
  }

  async function revoke(target: AdminUserView) {
    if (
      !window.confirm(
        `Revoke administrator access for ${target.email}? This will immediately disable their access.`
      )
    ) {
      return;
    }
    setActionInProgress(`revoke-${target.uid}`);
    try {
      const idToken = await user.getIdToken();
      const res = await fetch(`/api/admin/users/${target.uid}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${idToken}` },
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        onStatusMessage(data.error ?? "Revoke failed.");
        return;
      }
      onStatusMessage("Administrator access revoked.");
      await load();
    } catch (error) {
      console.error(error);
      onStatusMessage("Revoke failed. Please try again.");
    } finally {
      setActionInProgress(null);
    }
  }

  return (
    <div className="space-y-8">
      <section className="rounded-lg border border-stone bg-paper p-5">
        <h2 className="text-lg font-semibold">Invite Administrator</h2>
        <form onSubmit={invite} className="mt-4 grid gap-4 sm:grid-cols-[1fr_auto_auto]">
          <label className="text-sm">
            <span className="mb-1 block font-medium">Email</span>
            <input
              type="email"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              required
              className="w-full rounded-md border border-stone px-3 py-2"
              placeholder="colleague@example.com"
            />
          </label>
          <label className="text-sm">
            <span className="mb-1 block font-medium">Role</span>
            <select
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as AdminRole)}
              className="w-full rounded-md border border-stone px-3 py-2"
            >
              <option value="admin">Admin</option>
              <option value="superadmin">Superadmin</option>
            </select>
          </label>
          <div className="flex items-end">
            <Button type="submit" disabled={actionInProgress === "invite"}>
              {actionInProgress === "invite" ? "Inviting..." : "Invite"}
            </Button>
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-stone bg-paper p-5">
        <h2 className="text-lg font-semibold">Administrators</h2>
        {loading ? (
          <p className="mt-3 text-sm text-muted-foreground">Loading...</p>
        ) : admins.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No administrators found.</p>
        ) : (
          <ul className="mt-4 divide-y divide-stone">
            {admins.map((admin) => (
              <li key={admin.uid} className="py-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium">{admin.email}</p>
                    {admin.displayName && (
                      <p className="text-sm text-muted-foreground">{admin.displayName}</p>
                    )}
                    <div className="mt-1 flex flex-wrap items-center gap-2">
                      <Badge variant={admin.role === "superadmin" ? "default" : "secondary"}>
                        {admin.role}
                      </Badge>
                      <Badge
                        variant={admin.status === "active" ? "outline" : "secondary"}
                        className={admin.status === "disabled" ? "text-ember" : ""}
                      >
                        {admin.status}
                      </Badge>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {admin.role === "admin" && admin.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionInProgress === `update-${admin.uid}`}
                        onClick={() => updateAdmin(admin, { role: "superadmin" })}
                      >
                        Promote
                      </Button>
                    )}
                    {admin.role === "superadmin" && admin.status === "active" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionInProgress === `update-${admin.uid}`}
                        onClick={() => updateAdmin(admin, { role: "admin" })}
                      >
                        Demote
                      </Button>
                    )}
                    {admin.status === "active" ? (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionInProgress === `update-${admin.uid}`}
                        onClick={() => updateAdmin(admin, { status: "disabled" })}
                      >
                        Disable
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={actionInProgress === `update-${admin.uid}`}
                        onClick={() => updateAdmin(admin, { status: "active" })}
                      >
                        Reactivate
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={actionInProgress === `revoke-${admin.uid}`}
                      onClick={() => revoke(admin)}
                    >
                      Revoke
                    </Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-stone bg-paper p-5">
        <h2 className="text-lg font-semibold">Pending Invitations</h2>
        {invitations.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">No pending invitations.</p>
        ) : (
          <ul className="mt-4 divide-y divide-stone">
            {invitations.map((invitation) => (
              <li
                key={invitation.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div>
                  <p className="font-medium">{invitation.email}</p>
                  <p className="text-sm text-muted-foreground">
                    Role: {invitation.role} • Invited: {formatAdminDate(invitation.createdAt)}
                    {invitation.lastEmailAttemptAt ? (
                      <>
                        {" "}
                        • Last email: {formatAdminDateTime(invitation.lastEmailAttemptAt)}
                        {invitation.emailStatus ? ` (${invitation.emailStatus})` : ""}
                      </>
                    ) : null}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">Pending</Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={actionInProgress === `resend-${invitation.id}`}
                    onClick={() => resend(invitation)}
                  >
                    {actionInProgress === `resend-${invitation.id}`
                      ? "Sending..."
                      : "Resend email"}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
