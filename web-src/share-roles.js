// What someone other than the owner may do with a repertoire. The server's
// order is view < copy < edit; every role can do what the ones before it can.
export const ROLE_LABELS = { view: "View only", copy: "Can copy", edit: "Can edit" };
export const GRANT_ROLES = ["view", "copy", "edit"];
// "Anyone with the link" never edits: editing needs a named person or team.
export const LINK_ROLES = ["view", "copy"];

// What a role lets its holder do, for an on-demand tooltip on a role badge.
const ROLE_ALLOWS = {
  view: "Open and read",
  copy: "Open, read and copy to your account",
  edit: "Open, edit and copy to your account",
};

export const roleLabel = (role) => ROLE_LABELS[role] || "";
export const roleAllows = (role) => ROLE_ALLOWS[role] || "";
export const canCopy = (role) => role === "copy" || role === "edit" || role === "owner";
// A payload without a role came from a create/import: the caller owns it.
export const buildRole = (build) => (build && build.role) || "owner";
