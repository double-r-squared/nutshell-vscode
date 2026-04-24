'use strict'

const fs = require('fs')
const path = require('path')

// Ensure `entry` (one line, no trailing slash) appears in the workspace's
// .gitignore. Creates the file if it doesn't exist. Idempotent.
function ensureGitignoreEntry(workspaceRoot, entry) {
	const gitignorePath = path.join(workspaceRoot, '.gitignore')
	const line = entry.replace(/\/$/, '') + '/'
	let content = ''
	if (fs.existsSync(gitignorePath)) {
		content = fs.readFileSync(gitignorePath, 'utf8')
		const patterns = [entry, entry + '/', line]
		for (const p of patterns) {
			const re = new RegExp(`^${escapeRe(p)}\\s*$`, 'm')
			if (re.test(content)) return false
		}
		if (!content.endsWith('\n')) content += '\n'
	}
	content += `# Nutshell — auto-generated G2-formatted docs\n${line}\n`
	fs.writeFileSync(gitignorePath, content, 'utf8')
	return true
}

function escapeRe(s) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

module.exports = { ensureGitignoreEntry }
