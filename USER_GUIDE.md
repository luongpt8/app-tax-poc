# Hướng dẫn sử dụng Checkout Tax Integration

## Tổng quan

Checkout Tax Integration kết nối Adobe Commerce Checkout với dịch vụ tính thuế bên ngoài. Ứng dụng có hai phần chính:

- **Tax management**: quản lý tax class của Commerce và mã thuế tùy chỉnh.
- **Tax calculation**: gửi thông tin sản phẩm, địa chỉ giao hàng và phí giao hàng đến dịch vụ thuế, sau đó dùng kết quả để tính thuế cho checkout.

Tax class dùng để phân loại sản phẩm, phí giao hàng hoặc khách hàng. Việc tạo tax class không tự thiết lập mức thuế; mức thuế được tính bởi dịch vụ thuế đã cấu hình.

## Trước khi sử dụng

- Ứng dụng đã được cài đặt và liên kết (associated) với đúng Commerce instance.
- Tài khoản Adobe/Commerce của bạn có quyền truy cập Admin và quyền đọc, tạo, cập nhật, xóa tax class.
- Dịch vụ thuế có sẵn Base URL, API endpoint và API key hợp lệ.

## Mở trang quản lý tax class

Trong Commerce Admin, mở **Stores > Tax management**. Trang **Manage Tax Classes** hiển thị các tax class đã tải từ Commerce cùng các thông tin:

| Cột | Ý nghĩa |
| --- | --- |
| Commerce ID | ID của tax class trong Commerce |
| Class Type | Loại class: `PRODUCT`, `SHIPPING` hoặc `CUSTOMER` |
| Class Name | Tên tax class |
| Custom Tax Code | Mã và nhãn được gửi kèm đến dịch vụ thuế |
| Actions | Thao tác sửa hoặc xóa |

Trang hiện tải tối đa 100 tax class đầu tiên.

## Tạo tax class

1. Chọn **Add New Tax Class**.
2. Nhập **Class Name**.
3. Chọn **Class Type**: `PRODUCT`, `SHIPPING` hoặc `CUSTOMER`.
4. Chọn **Save**.

Tên class là bắt buộc và phải chứa ít nhất một chữ cái hoặc chữ số. Ứng dụng tự tạo **Custom Tax Code** từ tên: chuyển thành chữ hoa, thay chuỗi ký tự không phải chữ hoặc số bằng dấu gạch dưới, rồi bỏ dấu gạch dưới ở đầu và cuối. **Custom Tax Label** được đặt bằng tên class.

Ví dụ: `Reduced Rate Goods` tạo mã `REDUCED_RATE_GOODS` và nhãn `Reduced Rate Goods`.

## Sửa tax class

Chọn **Edit** ở dòng tương ứng, cập nhật **Class Name**, rồi chọn **Save**. Mã và nhãn thuế tùy chỉnh sẽ được tạo lại từ tên mới.

**Class Type không thể thay đổi khi sửa.** Nếu chọn nhầm loại, hãy tạo class mới với loại đúng, cập nhật các nơi đang sử dụng class cũ, rồi xóa class cũ nếu Commerce cho phép.

## Xóa tax class

Chọn **Delete**, kiểm tra tên class trong hộp thoại xác nhận, rồi xác nhận xóa. Thao tác này không thể hoàn tác. Commerce có thể từ chối xóa class đang được sử dụng; khi đó hãy gỡ class khỏi các sản phẩm, cấu hình hoặc đối tượng liên quan trước khi thử lại.

## Cấu hình dịch vụ tính thuế

Trong cấu hình của ứng dụng trên App Management, điền các giá trị sau:

| Trường | Giá trị |
| --- | --- |
| **Enable App** | Bật/tắt xử lý tính thuế; mặc định bật |
| **Base URL APP MOC DATA** | Base URL của dịch vụ thuế |
| **API APP MOC DATA** | Endpoint tính thuế; mặc định là `/api/v1/web/commerce-poc/tax-calculate` |
| **API key** | API key do dịch vụ thuế cấp |

API key được khai báo là trường mật khẩu. Không chia sẻ giá trị này trong tài liệu, ảnh chụp màn hình hoặc log. URL endpoint phải cùng origin với Base URL.

Khi tắt **Enable App** và lưu Business Config, ứng dụng không gọi dịch vụ thuế và không thay đổi thuế checkout hoặc thuế điều chỉnh credit memo. Ứng dụng vẫn được cài đặt và trang Tax management vẫn truy cập được. Bật lại và lưu để tiếp tục tính thuế. Cấu hình có thể được cache tối đa 5 phút trước khi webhook nhận giá trị mới.

Khi checkout yêu cầu tính thuế, ứng dụng gửi danh sách sản phẩm, số lượng, SKU, tax class/tax code, chiết khấu, địa chỉ giao hàng và phí giao hàng tới dịch vụ. Dịch vụ cần trả kết quả thành công gồm thuế cho từng SKU và thuế phí giao hàng nếu có. Hiện tại request gửi currency là `USD`; hãy xác nhận điều này phù hợp với cửa hàng và dịch vụ thuế trước khi dùng cho giao dịch thực tế.

## Xử lý sự cố

- **Trang không tải được hoặc danh sách trống**: kiểm tra ứng dụng đã liên kết đúng Commerce instance, phiên đăng nhập còn hiệu lực và tài khoản có quyền đọc tax class. Danh sách trống cũng có thể có nghĩa là chưa tạo tax class nào.
- **Không lưu được class**: kiểm tra tên không để trống và có ít nhất một chữ cái hoặc chữ số; nếu Commerce trả lỗi, xử lý thông báo hiển thị trong hộp thoại.
- **Không xóa được class**: class có thể đang được tham chiếu bởi sản phẩm hoặc dữ liệu Commerce khác. Gỡ liên kết đó trước khi xóa.
- **Checkout báo lỗi tính thuế**: xác nhận Base URL, endpoint và API key; kiểm tra dịch vụ có thể truy cập được và trả kết quả đúng định dạng. Nếu cấu hình thiếu hoặc dịch vụ trả lỗi, checkout sẽ không nhận được kết quả tính thuế.
- **Không thấy một tax class trong bảng**: bảng hiện chỉ tải 100 mục đầu tiên.
