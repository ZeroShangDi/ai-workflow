export const projectName = root => root?.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '当前项目';
