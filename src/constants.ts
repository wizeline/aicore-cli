declare const process: any;

export const AGENTS_DIR = '.agents';
export const SKILLS_SUBDIR = process.env?.IS_AGENTS_CLI ? 'agents' : 'skills';
export const UNIVERSAL_SKILLS_DIR = `${AGENTS_DIR}/${SKILLS_SUBDIR}`;
