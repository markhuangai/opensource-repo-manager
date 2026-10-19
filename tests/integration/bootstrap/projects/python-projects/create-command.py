import os
import pathlib
import sys
assert os.getuid() != 0
assert sys.prefix == os.environ['VIRTUAL_ENV']
command = pathlib.Path(sys.prefix, 'bin', 'project-version')
command.write_text(f'#!{sys.executable}\nimport packaging\nprint(packaging.__version__)\n')
command.chmod(0o700)
