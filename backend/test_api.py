import io

from fastapi.testclient import TestClient
from PIL import Image

from backend.main import app

client = TestClient(app)


def image_bytes(size=(120, 80), color="white", kind="PNG"):
    data = io.BytesIO()
    Image.new("RGB", size, color).save(data, kind)
    return data.getvalue()


def test_upload_dimensions_text_and_colors():
    response = client.post("/api/convert", data={"columns": 80, "contrast": 0},
                           files={"file": ("test.png", image_bytes(), "image/png")})
    assert response.status_code == 200
    data = response.json()
    assert data["columns"] == 80
    assert data["rows"] == 27
    assert all(len(line) == 80 for line in data["lines"])
    assert data["text"] == "\n".join(data["lines"])
    assert len(data["colors"]) == 80 * 27
    assert set(data["colors"]) == {"#ffffff"}


def test_rotation_and_inversion():
    upload = {"file": ("test.png", image_bytes((100, 200)), "image/png")}
    data = client.post("/api/convert", data={"columns": 80, "rotation": 90,
                       "charset": "custom", "custom": " .#", "invert": True}, files=upload).json()
    assert data["rows"] == 20
    assert set(data["text"].replace("\n", "")) == {" "}


def test_custom_ramp_and_brightness():
    upload = {"file": ("black.png", image_bytes(color="black"), "image/png")}
    data = client.post("/api/convert", data={"charset": "custom", "custom": "ab",
                       "brightness": 100, "contrast": 0}, files=upload).json()
    assert set(data["text"].replace("\n", "")) == {"b"}


def test_bad_file_and_parameters():
    assert client.post("/api/convert", files={"file": ("bad.png", b"not an image", "image/png")}).status_code == 400
    for fields in ({"columns": 1001}, {"gamma": 0}, {"rotation": 45},
                   {"charset": "custom", "custom": "\n"}, {"charset": "invalid"}):
        assert client.post("/api/convert", data=fields).status_code == 422


def test_maximum_detail_1000():
    response = client.post("/api/convert", data={"columns": 1000})
    assert response.status_code == 200
    data = response.json()
    assert data["columns"] == 1000
    assert data["rows"] > 500
    assert all(len(line) == 1000 for line in data["lines"])


def test_upload_limit():
    response = client.post("/api/convert", files={"file": ("large.png", b"0" * (20 * 1024 * 1024 + 1), "image/png")})
    assert response.status_code == 413


def test_mirror_and_original_colors():
    image = Image.new("RGB", (80, 40), "red")
    image.paste("blue", (40, 0, 80, 40))
    stream = io.BytesIO()
    image.save(stream, "PNG")
    upload = {"file": ("two.png", stream.getvalue(), "image/png")}
    data = client.post("/api/convert", data={"columns":40, "mirror":True, "contrast":0}, files=upload).json()
    assert data["colors"][0] == "#0000ff"
    assert data["colors"][39] == "#ff0000"


def test_demo_and_health():
    assert client.get("/api/health").json() == {"status": "ok"}
    assert client.get("/api/demo").headers["content-type"] == "image/png"
    assert client.post("/api/convert").status_code == 200
