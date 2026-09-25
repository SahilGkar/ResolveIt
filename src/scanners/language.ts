export interface LanguageInfo {
  readonly id: string;
  readonly name: string;
  readonly extensions: ReadonlyArray<string>;
  readonly filenames: ReadonlyArray<string>;
}

export const LANGUAGE_DEFINITIONS: ReadonlyArray<LanguageInfo> = [
  { id: 'python', name: 'Python', extensions: ['.py', '.pyw', '.pyi', '.pxd', '.pxi', '.pyd'], filenames: ['requirements.txt', 'pyproject.toml', 'setup.py', 'setup.cfg', 'Pipfile', 'poetry.lock'] },
  { id: 'javascript', name: 'JavaScript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], filenames: ['package.json', 'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] },
  { id: 'typescript', name: 'TypeScript', extensions: ['.ts', '.tsx', '.mts', '.cts'], filenames: ['tsconfig.json', 'tslint.json'] },
  { id: 'java', name: 'Java', extensions: ['.java', '.class', '.jar', '.gradle', '.gradle.kts'], filenames: ['pom.xml', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts'] },
  { id: 'c', name: 'C', extensions: ['.c', '.h'], filenames: ['Makefile', 'CMakeLists.txt', 'configure.ac', 'configure.in'] },
  { id: 'cpp', name: 'C++', extensions: ['.cpp', '.cxx', '.cc', '.c++', '.hpp', '.hxx', '.hh', '.h++'], filenames: ['Makefile', 'CMakeLists.txt'] },
  { id: 'csharp', name: 'C#', extensions: ['.cs', '.csx'], filenames: ['*.csproj', '*.sln', 'packages.config', 'Directory.Build.props', 'Directory.Build.targets', 'nuget.config'] },
  { id: 'go', name: 'Go', extensions: ['.go'], filenames: ['go.mod', 'go.sum', 'go.work'] },
  { id: 'rust', name: 'Rust', extensions: ['.rs'], filenames: ['Cargo.toml', 'Cargo.lock', 'rust-toolchain', 'rust-toolchain.toml'] },
  { id: 'ruby', name: 'Ruby', extensions: ['.rb', '.rake', '.gemspec'], filenames: ['Gemfile', 'Gemfile.lock', 'Rakefile', '.ruby-version', '.ruby-gemset'] },
  { id: 'php', name: 'PHP', extensions: ['.php', '.phtml', '.php3', '.php4', '.php5', '.phps', '.phar'], filenames: ['composer.json', 'composer.lock', 'phpunit.xml', 'phpunit.xml.dist', 'psalm.xml', 'phpstan.neon'] },
  { id: 'kotlin', name: 'Kotlin', extensions: ['.kt', '.kts'], filenames: ['build.gradle.kts', 'settings.gradle.kts', 'pom.xml'] },
  { id: 'swift', name: 'Swift', extensions: ['.swift'], filenames: ['Package.swift', 'Package.resolved', 'Podfile', 'Podfile.lock', 'Cartfile', 'Cartfile.resolved'] },
  { id: 'dart', name: 'Dart', extensions: ['.dart'], filenames: ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml'] },
  { id: 'r', name: 'R', extensions: ['.r', '.R', '.rmd', '.Rmd'], filenames: ['DESCRIPTION', 'NAMESPACE', 'renv.lock'] },
  { id: 'lua', name: 'Lua', extensions: ['.lua'], filenames: ['luarocks.toml', '.luacheckrc'] },
  { id: 'shell', name: 'Shell', extensions: ['.sh', '.bash', '.zsh', '.fish', '.ksh', '.csh'], filenames: ['.bashrc', '.zshrc', '.profile', '.bash_profile'] },
  { id: 'html', name: 'HTML', extensions: ['.html', '.htm', '.xhtml', '.html5'], filenames: [] },
  { id: 'css', name: 'CSS', extensions: ['.css', '.scss', '.sass', '.less', '.styl'], filenames: [] },
  { id: 'sql', name: 'SQL', extensions: ['.sql'], filenames: [] },
  { id: 'json', name: 'JSON', extensions: ['.json', '.jsonc'], filenames: [] },
  { id: 'yaml', name: 'YAML', extensions: ['.yaml', '.yml'], filenames: [] },
  { id: 'toml', name: 'TOML', extensions: ['.toml'], filenames: [] },
  { id: 'xml', name: 'XML', extensions: ['.xml', '.xsd', '.xsl', '.xslt', '.svg'], filenames: [] },
  { id: 'markdown', name: 'Markdown', extensions: ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'], filenames: ['README.md', 'README.markdown', 'CHANGELOG.md', 'CONTRIBUTING.md'] },
  { id: 'dockerfile', name: 'Dockerfile', extensions: ['.dockerfile'], filenames: ['Dockerfile', 'dockerfile', 'Containerfile', 'containerfile'] },
  { id: 'makefile', name: 'Makefile', extensions: [], filenames: ['Makefile', 'makefile', 'GNUmakefile', 'Makefile.am', 'Makefile.in'] },
  { id: 'cmake', name: 'CMake', extensions: ['.cmake'], filenames: ['CMakeLists.txt', 'CMakeCache.txt', 'cmake_install.cmake'] },
  { id: 'gradle', name: 'Gradle', extensions: ['.gradle'], filenames: ['build.gradle', 'settings.gradle', 'gradle.properties'] },
  { id: 'maven', name: 'Maven', extensions: [], filenames: ['pom.xml'] },
  { id: 'nim', name: 'Nim', extensions: ['.nim'], filenames: ['*.nimble'] },
  { id: 'elixir', name: 'Elixir', extensions: ['.ex', '.exs'], filenames: ['mix.exs', 'mix.lock'] },
  { id: 'erlang', name: 'Erlang', extensions: ['.erl', '.hrl'], filenames: ['rebar.config', 'rebar.lock'] },
  { id: 'haskell', name: 'Haskell', extensions: ['.hs', '.lhs'], filenames: ['*.cabal', 'stack.yaml', 'cabal.project'] },
  { id: 'ocaml', name: 'OCaml', extensions: ['.ml', '.mli', '.re', '.rei'], filenames: ['dune', 'dune-project', '*.opam'] },
  { id: 'fsharp', name: 'F#', extensions: ['.fs', '.fsi', '.fsx'], filenames: ['*.fsproj', 'paket.dependencies', 'paket.lock'] },
  { id: 'scala', name: 'Scala', extensions: ['.scala', '.sc'], filenames: ['build.sbt', 'build.sc', 'project/build.properties', 'project/plugins.sbt'] },
  { id: 'clojure', name: 'Clojure', extensions: ['.clj', '.cljs', '.cljc', '.edn'], filenames: ['project.clj', 'deps.edn', 'build.boot', 'shadow-cljs.edn'] },
  { id: 'vim', name: 'Vim script', extensions: ['.vim'], filenames: ['.vimrc', '_vimrc'] },
  { id: 'powershell', name: 'PowerShell', extensions: ['.ps1', '.psm1', '.psd1'], filenames: [] },
  { id: 'batch', name: 'Batch', extensions: ['.bat', '.cmd'], filenames: [] },
  { id: 'perl', name: 'Perl', extensions: ['.pl', '.pm', '.pod', '.t'], filenames: ['Makefile.PL', 'Build.PL', 'cpanfile', 'cpanfile.snapshot'] },
  { id: 'assembly', name: 'Assembly', extensions: ['.asm', '.s', '.S', '.nasm'], filenames: [] },
  { id: 'verilog', name: 'Verilog', extensions: ['.v', '.vh', '.sv', '.svh'], filenames: [] },
  { id: 'vhdl', name: 'VHDL', extensions: ['.vhd', '.vhdl'], filenames: [] },
  { id: 'protobuf', name: 'Protocol Buffers', extensions: ['.proto'], filenames: [] },
  { id: 'graphql', name: 'GraphQL', extensions: ['.graphql', '.gql'], filenames: [] },
  { id: 'terraform', name: 'Terraform', extensions: ['.tf', '.tfvars', '.tfstate', '.tfstate.backup'], filenames: [] },
  { id: 'helm', name: 'Helm', extensions: [], filenames: ['Chart.yaml', 'Chart.lock', 'values.yaml', 'values.yml'] },
  { id: 'kotlin-script', name: 'Kotlin Script', extensions: ['.kts'], filenames: [] },
];

export const EXTENSION_TO_LANGUAGE: ReadonlyMap<string, string> = new Map(
  LANGUAGE_DEFINITIONS.flatMap(lang => lang.extensions.map(ext => [ext.toLowerCase(), lang.id]))
);

export const FILENAME_TO_LANGUAGE: ReadonlyMap<string, string> = new Map(
  LANGUAGE_DEFINITIONS.flatMap(lang => lang.filenames.map(name => [name.toLowerCase(), lang.id]))
);

export function detectLanguage(filePath: string): string | undefined {
  const lowerPath = filePath.toLowerCase();
  const fileName = lowerPath.split(/[/\\]/).pop() || '';
  
  if (FILENAME_TO_LANGUAGE.has(fileName)) {
    return FILENAME_TO_LANGUAGE.get(fileName);
  }
  
  const extIndex = fileName.lastIndexOf('.');
  if (extIndex >= 0) {
    const ext = fileName.substring(extIndex);
    if (EXTENSION_TO_LANGUAGE.has(ext)) {
      return EXTENSION_TO_LANGUAGE.get(ext);
    }
  }
  
  return undefined;
}

export function detectLanguages(filePaths: ReadonlyArray<string>): ReadonlyArray<string> {
  const languages = new Set<string>();
  for (const path of filePaths) {
    const lang = detectLanguage(path);
    if (lang) {
      languages.add(lang);
    }
  }
  return Array.from(languages).sort();
}