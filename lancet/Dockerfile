# LANCET Nano 0.4.3 behind llama.cpp's /v1/systemone endpoint, for pi-automode-classifier.
# Build: docker build -t pi-automode-lancet:0.4.3 lancet/
FROM python:3.13-slim
# The release bundle and its SHA-256 from the release's SHA256SUMS.txt.
ARG URL=https://github.com/TannerMidd/LANCET-model/releases/download/v0.4.3/lancet-v0.4.3-nano-cpu-int8.zip
ARG SHA256=75b7307abf16a9c63806be6a6aa88e9b18cc463cddf7e4fdc6c9b8e27d4c985c
# The versions in the bundle's requirements.txt.
RUN pip install --no-cache-dir numpy==2.5.3 tokenizers==0.23.2 onnxruntime==1.30.0
RUN python -c "import hashlib, sys, urllib.request, zipfile; \
urllib.request.urlretrieve(sys.argv[1], '/tmp/lancet.zip'); \
got = hashlib.sha256(open('/tmp/lancet.zip', 'rb').read()).hexdigest(); \
sys.exit(f'bundle SHA-256 {got}, expected {sys.argv[2]}') if got != sys.argv[2] else None; \
zipfile.ZipFile('/tmp/lancet.zip').extractall('/opt')" "$URL" "$SHA256" \
 && rm /tmp/lancet.zip
COPY server.py /opt/server.py
USER 65534:65534
EXPOSE 8080
CMD ["python", "-I", "/opt/server.py", "--model", "/opt/lancet-v0.4.3-nano-cpu-int8/model", "--host", "0.0.0.0", "--port", "8080"]
