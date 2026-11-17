import { createAccessControl } from 'better-auth/plugins/access';
import {
  adminAc as platformAdminAc,
  defaultStatements as platformStatements,
  userAc as platformUserAc,
} from 'better-auth/plugins/admin/access';
import {
  adminAc as orgAdminAc,
  defaultStatements as orgStatements,
  memberAc as orgMemberAc,
  ownerAc as orgOwnerAc,
} from 'better-auth/plugins/organization/access';

/**
 * Workspace roles (`organization` plugin custom access control). Resource names
 * (`organization`, `member`, `invitation`, …) are the plugin's own; app resources (comments,
 * rules, …) get added here by later modules.
 * - owner: everything, incl. deleting the workspace (one per workspace, `creatorRole`).
 * - admin: manage members/invitations and settings, can't delete the workspace.
 * - moderator: no management rights; works the comment queue.
 */
export const workspaceAc = createAccessControl(orgStatements);

export const workspaceRoles = {
  owner: workspaceAc.newRole(orgOwnerAc.statements),
  admin: workspaceAc.newRole(orgAdminAc.statements),
  moderator: workspaceAc.newRole(orgMemberAc.statements),
};

/** Platform roles (`admin` plugin): `super_admin` gets every admin-plugin permission. */
export const platformAc = createAccessControl(platformStatements);

export const platformRoles = {
  super_admin: platformAc.newRole(platformAdminAc.statements),
  user: platformAc.newRole(platformUserAc.statements),
};
