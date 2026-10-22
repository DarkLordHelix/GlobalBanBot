import { Bot } from './yapper.js';
import { readFile, writeFile, rename } from 'node:fs/promises';

// Configure these two values before starting the bot.
const TOKEN = process.env.YAPPER_BOT_TOKEN || 'yb_20217b5a.F1MUuZjJx4798wRj3PqnWqzzqE9A0paW0Uo9UEaq';
const OWNER_USER_ID = '59678b5c-0591-41cf-b0f5-bd68d5c12883';

// /syncbans is available to the server owner and members whose server roles
// have Manage Server, Manage Messages, or a ban/moderation permission.
// Only OWNER_USER_ID can use /addglobalban.

if (!TOKEN.startsWith('yb_')) {
  console.error('Set YAPPER_BOT_TOKEN or replace PASTE_YOUR_TOKEN_HERE in global_ban_bot.js.');
  process.exit(1);
}

const bot = new Bot(TOKEN);
const DATA_FILE = new URL('./global-bans.json', import.meta.url);
const TEMP_FILE = new URL('./global-bans.json.tmp', import.meta.url);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Yapper user IDs are UUIDs. This accepts a plain ID or a mention such as <@uuid>.
function normalizeUserId(value) {
  let id = String(value ?? '').trim();
  const mention = id.match(/^<@!?([^>]+)>$/);
  if (mention) id = mention[1].trim();
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

const OWNER_ID = normalizeUserId(OWNER_USER_ID);

// Yapper exposes common permissions directly on a role and other permission
// flags under role.perms. Treat an inability to verify a member's permissions
// as a denial rather than letting an unverified person start a bulk-ban sync.
function roleCanSync(role) {
  if (role?.manage_server === true || role?.manage_messages === true) return true;
  const perms = role?.perms;
  if (!perms || typeof perms !== 'object') return false;
  return Object.entries(perms).some(([key, value]) =>
    value === true && /(ban|kick|timeout|moderation|manage_server|manage_messages)/i.test(key),
  );
}

async function canRunSync(serverId, userId) {
  const id = normalizeUserId(userId);
  if (!serverId || !id) return false;
  try {
    const [server, member, roles] = await Promise.all([
      bot.server(serverId),
      bot.member(serverId, id),
      bot.roles(serverId),
    ]);
    if (normalizeUserId(server?.owner_id) === id) return true;
    const heldRoleIds = new Set(Array.isArray(member?.roles) ? member.roles : []);
    return (Array.isArray(roles) ? roles : []).some(
      (role) => heldRoleIds.has(role.id) && roleCanSync(role),
    );
  } catch (error) {
    console.error('[global-bans] Could not verify sync permission:', error?.message || error);
    return false;
  }
}

// Map key: user ID. Values persist to global-bans.json beside this script.
const globalBans = new Map();

async function saveGlobalBans() {
  const data = [...globalBans.values()].sort((a, b) => a.user_id.localeCompare(b.user_id));
  await writeFile(TEMP_FILE, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  await rename(TEMP_FILE, DATA_FILE);
}

async function loadGlobalBans() {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, 'utf8'));
    if (!Array.isArray(parsed)) throw new Error('global-bans.json must contain a JSON array.');

    for (const item of parsed) {
      const id = normalizeUserId(item?.user_id);
      if (id) globalBans.set(id, { ...item, user_id: id });
    }
  } catch (error) {
    if (error.code === 'ENOENT') {
      await saveGlobalBans(); // Create an empty list on first run.
      return;
    }
    throw error; // Do not silently overwrite a damaged file.
  }
}

function getBannedUserId(entry) {
  if (typeof entry === 'string') return normalizeUserId(entry);
  return normalizeUserId(entry?.user_id ?? entry?.user?.id ?? entry?.id);
}

// Command 1: apply the global list to the server where the command is run.
// This does not import that server's local bans into the global list, and it
// does not unban anyone who is not on the global list.
bot.command('syncbans', 'Apply the global ban list to this server', async (msg) => {
  if (!msg.server_id) {
    await msg.reply('Run /syncbans inside a server, not in a DM.');
    return;
  }

  if (!(await canRunSync(msg.server_id, msg.author_id))) {
    await msg.reply('Only this server’s owner or a moderator with Manage Server, Manage Messages, or a ban/moderation permission can run /syncbans. If you should have access, check your server role permissions.');
    return;
  }

  if (globalBans.size === 0) {
    await msg.reply('The global ban list is empty. Add users with /addglobalban first.');
    return;
  }

  let serverBans;
  try {
    serverBans = await bot.bans(msg.server_id);
  } catch (error) {
    await msg.reply(`I could not read this server's ban list. Check that I have Ban permission. (${error.message})`);
    return;
  }

  const localIds = new Set((serverBans || []).map(getBannedUserId).filter(Boolean));
  let alreadyBanned = 0;
  let newlyBanned = 0;
  const failures = [];

  for (const entry of globalBans.values()) {
    if (localIds.has(entry.user_id)) {
      alreadyBanned++;
      continue;
    }

    try {
      await bot.ban(msg.server_id, entry.user_id);
      localIds.add(entry.user_id);
      newlyBanned++;
    } catch (error) {
      failures.push({ id: entry.user_id, message: String(error?.message || error).slice(0, 100) });
    }
  }

  const lines = [
    '**Global ban sync finished.**',
    `Users in global list: ${globalBans.size}`,
    `New bans applied: ${newlyBanned}`,
    `Already banned here: ${alreadyBanned}`,
    `Failed: ${failures.length}`,
  ];
  if (failures.length) {
    lines.push('', 'Some bans failed. Check the bot’s Ban permission and role position.');
    for (const failure of failures.slice(0, 4)) lines.push(`• ${failure.id}: ${failure.message}`);
    if (failures.length > 4) lines.push(`…and ${failures.length - 4} more.`);
  }
  await msg.reply(lines.join('\n'));
});

// Command 2: only the configured owner can add someone to the global list.
bot.command('addglobalban', 'Add a user ID to the global ban list (owner only)', async (msg) => {
  if (!OWNER_ID) {
    await msg.reply('The bot owner ID has not been configured. Set OWNER_USER_ID in global_ban_bot.js first.');
    return;
  }

  if (normalizeUserId(msg.author_id) !== OWNER_ID) {
    await msg.reply('⛔ Only the configured bot owner can use /addglobalban.');
    return;
  }

  const userId = normalizeUserId(msg.argv[0]);
  if (!userId) {
    await msg.reply('Usage: /addglobalban USER_ID [reason]\nUse the person’s Yapper user ID, not their username.');
    return;
  }

  if (globalBans.has(userId)) {
    await msg.reply(`That user is already on the global ban list: ${userId}`);
    return;
  }

  const reason = msg.argv.slice(1).join(' ').trim();
  globalBans.set(userId, {
    user_id: userId,
    reason,
    added_at: new Date().toISOString(),
    added_by: OWNER_ID,
  });

  try {
    await saveGlobalBans();
  } catch (error) {
    globalBans.delete(userId);
    await msg.reply(`I could not save global-bans.json, so the user was not added. (${error.message})`);
    return;
  }

  await msg.reply(
    `Added ${userId} to the global ban list.\n` +
    `List size: ${globalBans.size}. Run /syncbans in each server where you want this list applied.` +
    (reason ? `\nReason recorded: ${reason}` : ''),
  );
});

await loadGlobalBans();

bot.on('ready', (me) => console.log(`[global-bans] Online as ${me.username}; ${globalBans.size} user(s) in the global list.`));
bot.on('error', (error) => console.error('[global-bans]', error?.message || error));

bot.start().catch((error) => {
  console.error('[global-bans] Could not start:', error.message);
  process.exit(1);
});
