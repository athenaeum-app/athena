package seed

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"math"

	"github.com/google/uuid"
)

// newOpaqueName returns an opaque on-disk storage filename (a fresh UUID plus
// the given extension), mirroring the storage package's naming scheme.
func newOpaqueName(ext string) (string, error) {
	return uuid.NewString() + ext, nil
}

// This file generates tiny, fully valid media files programmatically so the
// seeder can exercise every attachment preview path (image, PDF, audio,
// animated image, and generic file chip) without committing any binary blobs
// to the repository. See ADR-0015 and the demo-seed plan.

// makePNG renders a small procedural PNG: a two-tone diagonal pattern over a
// solid background. The result is a valid, self-contained PNG image.
func makePNG(w, h int, bg, fg color.RGBA) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			// Diagonal stripes plus a soft radial vignette so the previews
			// are visually distinct from one another.
			if (x+y)%32 < 16 {
				img.SetRGBA(x, y, fg)
			} else {
				img.SetRGBA(x, y, bg)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// makeSolidPNG renders a flat-color PNG with a thin contrasting border. Handy
// for gallery tiles where each image just needs to read as a distinct swatch.
func makeSolidPNG(w, h int, fill color.RGBA) ([]byte, error) {
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	border := color.RGBA{R: 0x22, G: 0x22, B: 0x22, A: 0xFF}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if x < 3 || y < 3 || x >= w-3 || y >= h-3 {
				img.SetRGBA(x, y, border)
			} else {
				img.SetRGBA(x, y, fill)
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return nil, fmt.Errorf("encode png: %w", err)
	}
	return buf.Bytes(), nil
}

// makeAnimatedGIF builds a short looping GIF that cycles a moving bar through a
// small palette. It stands in for "motion" media: a real <video> preview needs
// a committed binary (a valid MP4 cannot be synthesised by hand), so the seeder
// ships an animated GIF instead and the report calls this out honestly.
func makeAnimatedGIF(w, h, frames int) ([]byte, error) {
	pal := color.Palette{
		color.RGBA{0x10, 0x12, 0x18, 0xFF},
		color.RGBA{0x4C, 0x8B, 0xF5, 0xFF},
		color.RGBA{0xF5, 0xA6, 0x23, 0xFF},
		color.RGBA{0xE9, 0xEC, 0xF2, 0xFF},
	}
	animation := &gif.GIF{LoopCount: 0}
	for f := 0; f < frames; f++ {
		img := image.NewPaletted(image.Rect(0, 0, w, h), pal)
		barX := (f * w) / frames
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				switch {
				case x >= barX && x < barX+w/4:
					img.SetColorIndex(x, y, 2)
				case (x+y+f)%20 < 10:
					img.SetColorIndex(x, y, 1)
				default:
					img.SetColorIndex(x, y, 0)
				}
			}
		}
		animation.Image = append(animation.Image, img)
		animation.Delay = append(animation.Delay, 12) // 120ms per frame
	}
	var buf bytes.Buffer
	if err := gif.EncodeAll(&buf, animation); err != nil {
		return nil, fmt.Errorf("encode gif: %w", err)
	}
	return buf.Bytes(), nil
}

// makeWAV synthesises a short mono 8-bit PCM WAV of a sine tone. The 44-byte
// canonical WAV header is written by hand followed by the raw samples, yielding
// a file browsers happily play in an <audio> element.
func makeWAV(freqHz float64, seconds float64) []byte {
	const sampleRate = 8000
	numSamples := int(float64(sampleRate) * seconds)
	dataLen := numSamples // 8-bit mono => 1 byte per sample

	var buf bytes.Buffer
	// RIFF header
	buf.WriteString("RIFF")
	binary.Write(&buf, binary.LittleEndian, uint32(36+dataLen))
	buf.WriteString("WAVE")
	// fmt chunk (PCM)
	buf.WriteString("fmt ")
	binary.Write(&buf, binary.LittleEndian, uint32(16)) // chunk size
	binary.Write(&buf, binary.LittleEndian, uint16(1))  // PCM
	binary.Write(&buf, binary.LittleEndian, uint16(1))  // mono
	binary.Write(&buf, binary.LittleEndian, uint32(sampleRate))
	binary.Write(&buf, binary.LittleEndian, uint32(sampleRate)) // byte rate (rate*channels*bytes)
	binary.Write(&buf, binary.LittleEndian, uint16(1))          // block align
	binary.Write(&buf, binary.LittleEndian, uint16(8))          // bits per sample
	// data chunk
	buf.WriteString("data")
	binary.Write(&buf, binary.LittleEndian, uint32(dataLen))
	for i := 0; i < numSamples; i++ {
		t := float64(i) / float64(sampleRate)
		// 8-bit PCM is unsigned, centred on 128.
		s := math.Sin(2*math.Pi*freqHz*t) * 90
		buf.WriteByte(byte(128 + int(s)))
	}
	return buf.Bytes()
}

// makePDF builds a minimal but valid single-page PDF with a line of text. The
// cross-reference table offsets are computed as the body is assembled so the
// document opens cleanly in a browser's PDF iframe viewer.
func makePDF(title string) []byte {
	objects := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		streamObject(fmt.Sprintf("BT /F1 20 Tf 24 110 Td (%s) Tj ET", pdfEscape(title))),
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	}

	var buf bytes.Buffer
	buf.WriteString("%PDF-1.4\n")
	buf.WriteString("%\xE2\xE3\xCF\xD3\n") // binary marker so tools treat it as binary

	offsets := make([]int, len(objects))
	for i, body := range objects {
		offsets[i] = buf.Len()
		fmt.Fprintf(&buf, "%d 0 obj\n%s\nendobj\n", i+1, body)
	}

	xrefStart := buf.Len()
	fmt.Fprintf(&buf, "xref\n0 %d\n", len(objects)+1)
	buf.WriteString("0000000000 65535 f \n")
	for _, off := range offsets {
		fmt.Fprintf(&buf, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&buf, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n",
		len(objects)+1, xrefStart)
	return buf.Bytes()
}

// streamObject wraps a content stream in a PDF stream object body with the
// correct /Length.
func streamObject(content string) string {
	return fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content)
}

// pdfEscape escapes the characters that are special inside a PDF literal string.
func pdfEscape(s string) string {
	out := make([]rune, 0, len(s))
	for _, r := range s {
		switch r {
		case '(', ')', '\\':
			out = append(out, '\\', r)
		default:
			out = append(out, r)
		}
	}
	return string(out)
}

// makeZip builds a tiny valid .zip archive containing a single text file. It
// serves as the "generic file" that renders as a download chip (no inline
// preview) in the client.
func makeZip(innerName, innerBody string) ([]byte, error) {
	var buf bytes.Buffer
	zipWriter := zip.NewWriter(&buf)
	f, err := zipWriter.Create(innerName)
	if err != nil {
		return nil, fmt.Errorf("create zip entry: %w", err)
	}
	if _, err := f.Write([]byte(innerBody)); err != nil {
		return nil, fmt.Errorf("write zip entry: %w", err)
	}
	if err := zipWriter.Close(); err != nil {
		return nil, fmt.Errorf("close zip: %w", err)
	}
	return buf.Bytes(), nil
}
