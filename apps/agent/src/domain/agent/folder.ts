// Назва теки сесії (і гілки agent/<тека>): змістовна назва з суфіксом id або сам id, якщо назви немає.
export const folderFor = (id: string, name?: string) => (name ? `${name}-${id.split("-").at(-1)}` : id);
